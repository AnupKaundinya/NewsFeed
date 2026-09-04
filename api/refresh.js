import { BUCKETS, BLOCKED_DOMAINS, REJECT_PATTERNS, TAGS, gnews } from "./_lib/sources.js";
import {
  supabase, llm, parseJsonish, readFeed, dedupeKey, domainOf,
  pacificToday, significantTerms, titleOverlap,
} from "./_lib/util.js";

const CHUNK = 1;              // one beat per invocation — spreads calls out under the free-tier ceiling
const PER_BUCKET = 4;         // stories kept per beat per run
const SHORTLIST = 6;          // candidates that reach the model
const DAILY_WINDOW = 5;       // days back for a normal refresh
const BACKFILL_WINDOW = 21;   // RSS rarely holds more than ~2-3 weeks

// ---------------------------------------------------------------------------
// Learning: read the signals table once per invocation.
// ---------------------------------------------------------------------------
async function loadLearning() {
  const { data, error } = await supabase
    .from("signals")
    .select("kind, bucket, domain, headline")
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw new Error(`signals read failed: ${error.message}`);

  const trustedDomains = new Map();   // domain -> boost
  const badDomains = new Map();       // domain -> penalty
  const learnedTerms = new Map();     // bucket -> Set(term)
  const examples = new Map();         // bucket -> { liked: [], disliked: [] }

  for (const s of data || []) {
    const ex = examples.get(s.bucket) || { liked: [], disliked: [] };
    if (s.kind === "submit") {
      if (s.domain) trustedDomains.set(s.domain, (trustedDomains.get(s.domain) || 0) + 2);
      if (s.bucket && s.headline) {
        const set = learnedTerms.get(s.bucket) || new Set();
        significantTerms(s.headline).slice(0, 6).forEach((t) => set.add(t));
        learnedTerms.set(s.bucket, set);
        if (ex.liked.length < 5) ex.liked.push(s.headline);
      }
    } else if (s.kind === "dismiss") {
      if (s.domain) badDomains.set(s.domain, (badDomains.get(s.domain) || 0) + 1);
      if (s.headline && ex.disliked.length < 5) ex.disliked.push(s.headline);
    }
    if (s.bucket) examples.set(s.bucket, ex);
  }

  return { trustedDomains, badDomains, learnedTerms, examples };
}

// ---------------------------------------------------------------------------
// Gather + mechanically filter a bucket's candidates.
// ---------------------------------------------------------------------------
async function gather(bucket, windowDays, learning) {
  const feeds = [...bucket.feeds, { url: gnews(bucket.query), tier: 3, kind: "press" }];
  const results = await Promise.all(feeds.map(readFeed));

  const health = results.map((r) => ({
    feed: r.url.startsWith("https://news.google.com") ? "google-news" : r.url,
    ok: r.ok,
    items: r.items.length,
    ...(r.error ? { error: r.error } : {}),
  }));

  const learned = learning.learnedTerms.get(bucket.id) || new Set();
  const keywords = [...bucket.keywords, ...learned];
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

    // topical relevance
    const hay = `${item.title} ${item.body}`.toLowerCase();
    if (!keywords.some((k) => hay.includes(k))) continue;

    seen.add(item.url);
    kept.push({ ...item, strikes });
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
  return candidates.sort((a, b) => b.score - a.score);
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

Choose AT MOST ${keep} — only the genuinely significant. Fewer is better than padding: an item that is
routine, promotional, a rehash, or too thin to matter should be left out. "outlets_covering" tells you how
many publishers filed the same story; broad coverage is evidence of significance but not proof.
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

  const expected = process.env.REFRESH_SECRET;
  if (expected) {
    const bearerOk = req.headers["authorization"] === `Bearer ${expected}`;
    if (req.headers["x-refresh-secret"] !== expected && !bearerOk && req.query?.secret !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const backfill = req.query?.mode === "backfill";
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
      if (keys.length) {
        const { data, error } = await supabase
          .from("stories")
          .select("dedupe_key")
          .in("dedupe_key", keys);
        if (error) throw new Error(`dedupe check failed: ${error.message}`);
        known = new Set((data || []).map((d) => d.dedupe_key));
      }
      const fresh = candidates.filter((c) => !known.has(dedupeKey(bucket.id, c.url)));

      if (!fresh.length) {
        report.push({ bucket: bucket.id, candidates: candidates.length, new: 0, kept: 0, llm_calls: 0 });
        continue;
      }

      const ranked = scoreCandidates(fresh, learning);
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

      rows.push(...stories);
      report.push({
        bucket: bucket.id,
        candidates: candidates.length,
        new: fresh.length,
        kept: stories.length,
        llm_calls: llmCalls,
      });
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

    return res.status(200).json({
      ok: true,
      mode: backfill ? "backfill" : "daily",
      done,
      next: done ? null : next,
      total_buckets: BUCKETS.length,
      buckets: report,
      stories_inserted: inserted,
      feed_health: feedHealth.flatMap((b) =>
        b.feeds.filter((f) => !f.ok || f.items === 0).map((f) => ({ bucket: b.bucket, ...f }))
      ),
    });
  } catch (err) {
    console.error("Refresh failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
