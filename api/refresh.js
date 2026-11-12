import { BUCKETS, BLOCKED_DOMAINS, REJECT_PATTERNS, TAGS, ANTI_PROFILE, gnews } from "./_lib/sources.js";
import { keywordMatcher, rankByRelevance } from "./_lib/relevance.js";
import {
  supabase, llm, parseJsonish, readFeed, dedupeKey, domainOf,
  pacificToday, significantTerms, titleOverlap,
  authorize,
} from "./_lib/util.js";

const CHUNK = 1;              // one beat per invocation — spreads calls out under the free-tier ceiling
const PER_BUCKET = 4;         // stories kept per beat per run
const SHORTLIST = 6;          // candidates that reach the model
const DAILY_WINDOW = 5;       // days back for a normal refresh
const BACKFILL_WINDOW = 21;   // RSS rarely holds more than ~2-3 weeks

// ---------------------------------------------------------------------------
// Learning: read the signals table once per invocation. Only the admin's
// feedback is ever recorded there, so it's the admin who shapes the feed.
// ---------------------------------------------------------------------------
async function loadLearning() {
  const { data, error } = await supabase
    .from("signals")
    .select("kind, bucket, domain, headline")
    .order("created_at", { ascending: false })
    .limit(300);

  // Learning only tunes ranking — if signals can't be read, run unpersonalized rather than fail.
  if (error) console.warn(`signals read failed, continuing without learning: ${error.message}`);

  const trustedDomains = new Map();   // domain -> boost
  const badDomains = new Map();       // domain -> penalty
  const learnedTerms = new Map();     // bucket -> Set(term)
  const examples = new Map();         // bucket -> { liked: [], disliked: [] } — a few, for the prompt
  const signals = new Map();          // bucket -> { liked: [], disliked: [] } — more, for embeddings
  const sig = (b) => {
    if (!signals.has(b)) signals.set(b, { liked: [], disliked: [] });
    return signals.get(b);
  };

  for (const s of data || []) {
    const ex = examples.get(s.bucket) || { liked: [], disliked: [] };
    if (s.kind === "submit") {
      if (s.domain) trustedDomains.set(s.domain, (trustedDomains.get(s.domain) || 0) + 2);
      if (s.bucket && s.headline) {
        const set = learnedTerms.get(s.bucket) || new Set();
        significantTerms(s.headline).slice(0, 6).forEach((t) => set.add(t));
        learnedTerms.set(s.bucket, set);
        if (ex.liked.length < 5) ex.liked.push(s.headline);
        if (sig(s.bucket).liked.length < 20) sig(s.bucket).liked.push(s.headline);
      }
    } else if (s.kind === "dismiss") {
      if (s.domain) badDomains.set(s.domain, (badDomains.get(s.domain) || 0) + 1);
      if (s.headline && ex.disliked.length < 5) ex.disliked.push(s.headline);
      if (s.bucket && s.headline && sig(s.bucket).disliked.length < 20) sig(s.bucket).disliked.push(s.headline);
    }
    if (s.bucket) examples.set(s.bucket, ex);
  }

  // Saved stories are the clearest "more like this" signal there is.
  // Only the admin's saves teach; everyone else's are just their own bookmarks.
  const { data: adminIds, error: adminError } = await supabase.rpc("admin_user_ids");
  if (adminError) console.warn(`admin lookup failed: ${adminError.message}`);
  const admins = (adminIds || []).map((r) => r.id ?? r);
  const { data: savedRows, error: savedError } = admins.length
    ? await supabase
      .from("story_state")
      .select("saved_at, stories(bucket, headline)")
      .eq("saved", true)
      .in("user_id", admins)
      .order("saved_at", { ascending: false, nullsFirst: false })
      .limit(100)
    : { data: [], error: null };
  if (savedError) console.warn(`saved stories read failed: ${savedError.message}`);
  const saved = (savedRows || []).map((r) => r.stories).filter(Boolean);
  for (const s of saved) {
    if (s.bucket && s.headline && sig(s.bucket).liked.length < 20) sig(s.bucket).liked.push(s.headline);
  }

  return { trustedDomains, badDomains, learnedTerms, examples, signals, degraded: !!error };
}

// ---------------------------------------------------------------------------
// Gather + mechanically filter a bucket's candidates.
// ---------------------------------------------------------------------------
async function gather(bucket, windowDays, learning) {
  // A beat may list several Google News queries; each is its own tier-3 feed.
  const queries = [].concat(bucket.query);
  const feeds = [...bucket.feeds, ...queries.map((q) => ({ url: gnews(q), tier: 3, kind: "press" }))];
  const results = await Promise.all(feeds.map(readFeed));

  const health = results.map((r) => ({
    feed: r.url.startsWith("https://news.google.com") ? "google-news" : r.url,
    ok: r.ok,
    items: r.items.length,
    ...(r.error ? { error: r.error } : {}),
  }));

  const learned = learning.learnedTerms.get(bucket.id) || new Set();
  // Learned terms are stems ("switch" from "switches"), so they match as prefixes.
  const isHit = keywordMatcher([...bucket.keywords, ...[...learned].map((t) => `${t}*`)]);
  const cutoff = Date.now() - windowDays * 86400000;

  const seen = new Set();
  const kept = [];

  for (const item of results.flatMap((r) => r.items)) {
    if (seen.has(item.url)) continue;

    // domain blocklist (learned dismissals join it after 3 strikes)
    const blocked = BLOCKED_DOMAINS.some((d) => item.domain.includes(d));
    const strikes = learning.badDomains.get(item.domain) || 0;
    if (blocked || strikes >= 3) continue;

    // junk title shapes
    if (REJECT_PATTERNS.some((re) => re.test(item.title))) continue;
    if (item.title.length < 20) continue;

    // recency — undated items are allowed through and judged on keywords
    if (item.published_at) {
      const t = new Date(item.published_at).getTime();
      if (t < cutoff || t > Date.now() + 2 * 86400000) continue;
    }

    // Keywords no longer gate: relevance is judged by meaning later
    // (api/_lib/relevance.js). A hit still counts, and is the fallback filter.
    seen.add(item.url);
    kept.push({ ...item, strikes, kwHit: isHit(`${item.title} ${item.body}`) });
  }

  return { candidates: kept, health };
}

// Corroboration: how many distinct publishers filed roughly this story.
function scoreCandidates(candidates, learning) {
  for (const c of candidates) {
    const peers = candidates.filter((o) => o !== c && titleOverlap(c.title, o.title) >= 0.5);
    const publishers = new Set(peers.map((p) => p.domain));
    c.corroboration = publishers.size;

    const tierScore = c.tier === 1 ? 4 : c.tier === 2 ? 2 : 0;
    const trust = learning.trustedDomains.get(c.domain) || 0;
    const recency = c.published_at
      ? Math.max(0, 3 - Math.floor((Date.now() - new Date(c.published_at).getTime()) / 86400000))
      : 0;

    c.score = tierScore + c.corroboration * 3 + trust + recency - c.strikes * 2;
  }
  // Relevance (from embeddings) is worth up to 6 points, scaled within this batch.
  const rels = candidates.map((c) => c.relevance).filter((r) => typeof r === "number");
  if (rels.length) {
    const lo = Math.min(...rels);
    const span = Math.max(...rels) - lo || 1;
    for (const c of candidates) {
      if (typeof c.relevance === "number") c.score += 6 * ((c.relevance - lo) / span);
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Same-event matching. Many outlets (and many Google News URLs) carry one story,
// so URL dedupe alone lets it in again and again. Words every story on the beat
// shares ("space", "data", "center") don't count as evidence of a match.
// ---------------------------------------------------------------------------
const stem = (t) => t.replace(/(es|s)$/, "");

function beatTerms(bucket) {
  return new Set(significantTerms([bucket.label, ...[].concat(bucket.query), ...bucket.keywords].join(" ")).map(stem));
}

function sameStory(a, b, common) {
  const A = [...new Set(significantTerms(a).map(stem))].filter((t) => !common.has(t));
  const B = new Set(significantTerms(b).map(stem).filter((t) => !common.has(t)));
  if (!A.length || !B.size) return false;
  const shared = A.filter((t) => B.has(t)).length;
  return shared >= 2 && shared / Math.min(A.length, B.size) >= 0.5;
}

// A feed description is usable as-is when it's a real sentence or two.
function usableTeaser(body) {
  if (!body) return null;
  const t = body.trim();
  if (t.length < 80 || t.length > 420) return null;
  if (/[.!?]$/.test(t) === false) return null;      // truncated
  if (/(read more|continue reading|\[…\]|\.\.\.$)/i.test(t)) return null;
  return t;
}

// ---------------------------------------------------------------------------
// One model call per bucket: choose the significant few, clean the headlines.
// Long summaries are NOT generated here — /api/summarize does that on expand.
// ---------------------------------------------------------------------------
async function selectAndLabel(bucket, shortlist, learning, keep) {
  const ex = learning.examples.get(bucket.id) || { liked: [], disliked: [] };

  const payload = shortlist.map((c, i) => ({
    i,
    title: c.title,
    source: c.source,
    outlets_covering: c.corroboration + 1,
    snippet: c.body.slice(0, 200),
    teaser_supplied: !!usableTeaser(c.body),
  }));

  const system = `You curate data center networking news for a professional working in the field.
Topic: "${bucket.label}".

You are given real articles already collected from RSS feeds. Do NOT invent articles, facts, or URLs.
Work only from the title and snippet provided.

Scope: this reader cares about the data center — the networks, silicon, systems, facilities and
companies that build and run data centers and AI clusters.
In scope:
- data center switching, routing, fabrics, optics and interconnect (including DCI); GPU/AI cluster networking
- switch, NIC, DPU and optical silicon; servers and rack-scale systems built for data centers
- hyperscalers, neoclouds and GPU clouds (CoreWeave, Crusoe, Vultr, Lambda, Nebius, Nscale, Together AI,
  Fluidstack and similar), colocation providers (Equinix, Digital Realty and similar): their builds,
  capacity, funding, deals, power and cooling
- standards and protocols for data center and AI networking
Out of scope, even when the vendor belongs to this beat:
- enterprise campus, branch and office networking: wired or wireless LAN, Wi-Fi, SD-WAN, SASE, retail or
  remote-site networking. (A "data center campus", meaning a site of several data center buildings, is in scope.)
- security products, collaboration and contact-center software, observability/Splunk, certifications and
  training, customer events, keynotes and webinars — unless the story is specifically about data center infrastructure
- telecom/5G/mobile, consumer tech, satellite broadband, AI model or app news, stock and analyst commentary

First, check relevance: an item earns a place only if it is in scope above and actually about data center
infrastructure, networking hardware/software, or this beat's ecosystem specifically — not just AI,
compute, or energy in general. A keyword match alone does not make something relevant. If the item
only mentions this beat in passing, or is a broader AI/tech/energy story without a data-center-specific
angle, exclude it, regardless of how significant or well-covered it is elsewhere.

Then, among what's left, choose AT MOST ${keep} — only the genuinely significant. Fewer is better than
padding: an item that is routine, promotional, a rehash, or too thin to matter should be left out.
"outlets_covering" tells you how many publishers filed the same story; broad coverage is evidence of
significance but not proof, and it never substitutes for relevance.
${ex.liked.length ? `\nStories this user explicitly flagged as worth surfacing:\n${ex.liked.map((h) => `- ${h}`).join("\n")}` : ""}
${ex.disliked.length ? `\nStories this user marked NOT relevant — avoid this kind:\n${ex.disliked.map((h) => `- ${h}`).join("\n")}` : ""}

Return ONLY a JSON object with a single key "selected", whose value is an array of the chosen items:
{ "selected": [ {
  "i": <the item's index>,
  "headline": "plain factual rewrite; strip clickbait and any ' - Publisher' suffix",
  "teaser": "1-2 sentence summary — or null if teaser_supplied is true",
  "tag": one of ${TAGS.map((t) => `"${t}"`).join(", ")}
} ] }
Use { "selected": [] } if nothing in the list is worth the user's attention.`;

  const raw = await llm(system, payload, 1200, { json: true });
  const rows = parseJsonish(raw, "selected");
  if (!Array.isArray(rows)) {
    console.error(`Unparseable model output for ${bucket.id}:`, String(raw).slice(0, 500));
    return [];   // skip this beat rather than failing the whole run
  }

  const out = [];
  const used = new Set();
  for (const r of rows) {
    const src = shortlist[r?.i];
    if (!src || used.has(r.i)) continue;
    used.add(r.i);
    out.push({
      bucket: bucket.id,
      headline: r.headline || src.title,
      teaser: r.teaser || usableTeaser(src.body) || src.title,
      summary: "",                       // filled lazily on first expand
      tag: TAGS.includes(r.tag) ? r.tag : "Other",
      source: src.source,                // from the feed, not the model
      url: src.url,                      // from the feed — cannot be fabricated
      domain: src.domain,                // publisher's domain, even for news.google.com links
      is_blog: src.is_blog,
      published_at: src.published_at,
      found_on: pacificToday(),
      is_manual: false,
      dedupe_key: dedupeKey(bucket.id, src.url),
    });
    if (out.length >= keep) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Any invited person can refresh; preview and backfill are for the admin or the secret.
  const special = req.query?.mode === "preview" || req.query?.mode === "backfill";
  if (!(await authorize(req, res, { adminOnly: special }))) return;

  try {
    const backfill = req.query?.mode === "backfill";
    // Preview: score one beat's candidates and return the numbers. No model call, nothing stored.
    const preview = req.query?.mode === "preview";
    const windowDays = backfill ? BACKFILL_WINDOW : DAILY_WINDOW;
    const perBucket = backfill ? 8 : PER_BUCKET;

    const cursor = Math.max(0, parseInt(req.query?.cursor ?? "0", 10) || 0);
    const slice = BUCKETS.slice(cursor, cursor + CHUNK);
    if (!slice.length) {
      return res.status(200).json({ ok: true, done: true, buckets: [], stories_inserted: 0 });
    }

    const learning = await loadLearning();

    const rows = [];
    const report = [];
    const feedHealth = [];

    for (const bucket of slice) {
      const { candidates, health } = await gather(bucket, windowDays, learning);
      feedHealth.push({ bucket: bucket.id, feeds: health });
      // Drop anything already stored BEFORE spending tokens on it.
      const keys = candidates.map((c) => dedupeKey(bucket.id, c.url));
      let known = new Set();
      // Chunked: without the keyword gate there can be a few hundred keys,
      // and they travel in the request URL.
      for (let i = 0; i < keys.length; i += 80) {
        const { data, error } = await supabase
          .from("stories")
          .select("dedupe_key")
          .in("dedupe_key", keys.slice(i, i + 80));
        if (error) throw new Error(`dedupe check failed: ${error.message}`);
        (data || []).forEach((d) => known.add(d.dedupe_key));
      }
      // ...and anything covering an event this beat already stored recently.
      const since = new Date(Date.now() - BACKFILL_WINDOW * 86400000).toISOString();
      const { data: recent, error: recentError } = await supabase
        .from("stories")
        .select("headline")
        .eq("bucket", bucket.id)
        .gte("created_at", since);
      if (recentError) throw new Error(`recent stories read failed: ${recentError.message}`);
      const storedHeadlines = (recent || []).map((r) => r.headline);
      const common = beatTerms(bucket);
      const isRepeat = (title) => storedHeadlines.some((h) => sameStory(title, h, common));

      const unseen = candidates.filter((c) => !known.has(dedupeKey(bucket.id, c.url)) && !isRepeat(c.title));

      // Keep only what's about this beat, by meaning (or whole-word keywords as a fallback).
      const sig = learning.signals.get(bucket.id) || { liked: [], disliked: [] };
      const relevance = await rankByRelevance(bucket, unseen, { ...sig, antiProfile: ANTI_PROFILE, beats: BUCKETS });
      const fresh = relevance.kept;

      if (preview) {
        report.push({
          bucket: bucket.id,
          relevance_mode: relevance.mode,
          ...(relevance.error ? { relevance_error: relevance.error } : {}),
          candidates: candidates.length,
          unseen: unseen.length,
          kept: fresh.length,
          scored: relevance.scored.sort((a, b) => (b.rel ?? 0) - (a.rel ?? 0)),
        });
        continue;
      }

      if (!fresh.length) {
        report.push({
          bucket: bucket.id, candidates: candidates.length, new: 0, kept: 0, llm_calls: 0,
          relevance_mode: relevance.mode,
        });
        continue;
      }

      // One candidate per event: the best-scored version of each story reaches the model.
      const ranked = [];
      for (const c of scoreCandidates(fresh, learning)) {
        if (!ranked.some((r) => sameStory(c.title, r.title, common))) ranked.push(c);
      }
      const shortlist = ranked.slice(0, SHORTLIST);
      let stories = await selectAndLabel(bucket, shortlist, learning, perBucket);
      let llmCalls = 1;

      // Blog fallback: a quiet beat still shows something, clearly labelled.
      if (!stories.length) {
        const fallback = ranked.find((c) => c.is_blog) || ranked[0];
        if (fallback) {
          stories = (await selectAndLabel(bucket, [fallback], learning, 1))
            .map((s) => ({ ...s, is_blog: true }));
          llmCalls = 2;
        }
      }

      // The model rewrites headlines, so check its output against stored stories too.
      stories = stories.filter((s) => !isRepeat(s.headline));

      rows.push(...stories);
      report.push({
        bucket: bucket.id,
        candidates: candidates.length,
        new: fresh.length,
        kept: stories.length,
        llm_calls: llmCalls,
        relevance_mode: relevance.mode,
        ...(relevance.error ? { relevance_error: relevance.error } : {}),
      });
    }

    if (preview) {
      return res.status(200).json({ ok: true, mode: "preview", buckets: report });
    }

    let inserted = 0;
    if (rows.length) {
      const { data, error } = await supabase
        .from("stories")
        .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`insert failed: ${error.message}`);
      inserted = data ? data.length : 0;
    }

    const next = cursor + CHUNK;
    const done = next >= BUCKETS.length;

    // Shared "last refreshed" stamp, so every reader's page knows the feed is current.
    if (done) {
      const { error: metaErr } = await supabase.from("app_meta")
        .upsert({ key: "last_refresh", value: new Date().toISOString(), updated_at: new Date().toISOString() });
      if (metaErr) console.warn(`last_refresh stamp failed: ${metaErr.message}`);
    }

    return res.status(200).json({
      ok: true,
      mode: backfill ? "backfill" : "daily",
      done,
      next: done ? null : next,
      total_buckets: BUCKETS.length,
      buckets: report,
      stories_inserted: inserted,
      ...(learning.degraded ? { learning_unavailable: true } : {}),
      feed_health: feedHealth.flatMap((b) =>
        b.feeds.filter((f) => !f.ok || f.items === 0).map((f) => ({ bucket: b.bucket, ...f }))
      ),
    });
  } catch (err) {
    console.error("Refresh failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
