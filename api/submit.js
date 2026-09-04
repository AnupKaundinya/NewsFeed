import { BUCKETS, TAGS } from "./_lib/sources.js";
import {
  supabase, llm, parseJsonish, stripHtml, normalizeUrl, domainOf,
  dedupeKey, pacificToday,
} from "./_lib/util.js";

// Pull a headline, description, publisher and date out of a page's metadata.
// No article body needed — Open Graph tags carry enough for a teaser.
function readMeta(html) {
  const pick = (...names) => {
    for (const n of names) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, "i"
      );
      const alt = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, "i"
      );
      const m = re.exec(html) || alt.exec(html);
      if (m) return stripHtml(m[1]);
    }
    return "";
  };

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return {
    title: pick("og:title", "twitter:title") || (titleTag ? stripHtml(titleTag[1]) : ""),
    description: pick("og:description", "twitter:description", "description"),
    site: pick("og:site_name", "application-name"),
    published: pick("article:published_time", "datePublished", "pubdate", "date"),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expected = process.env.REFRESH_SECRET;
  if (expected && req.headers["x-refresh-secret"] !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { url, bucket, note = "" } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "A valid http(s) URL is required" });
  }
  if (!BUCKETS.some((b) => b.id === bucket)) {
    return res.status(400).json({ ok: false, error: "Unknown bucket" });
  }

  const clean = normalizeUrl(url);
  const domain = domainOf(clean);
  const key = dedupeKey(bucket, clean);

  try {
    // Already have it? Just record the signal so it still teaches.
    const { data: existing } = await supabase
      .from("stories").select("id, headline").eq("dedupe_key", key).maybeSingle();

    // Fetch metadata. Paywalls and bot blocks are expected — degrade, don't fail.
    let meta = { title: "", description: "", site: "", published: "" };
    let fetchNote = null;
    try {
      const r = await fetch(clean, {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(10000),
        redirect: "follow",
      });
      if (r.ok) {
        meta = readMeta((await r.text()).slice(0, 250000));
      } else {
        fetchNote = `page returned HTTP ${r.status}`;
      }
    } catch (err) {
      fetchNote = err.name === "TimeoutError" ? "page fetch timed out" : "page could not be fetched";
    }

    const rawTitle = meta.title || note || clean;
    const source = meta.site || domain;
    const pub = meta.published ? new Date(meta.published) : null;
    const published_at = pub && !isNaN(pub.getTime()) ? pub.toISOString().slice(0, 10) : null;

    // Record the teaching signal regardless of what happens to the story row.
    const { error: sigErr } = await supabase.from("signals").insert({
      kind: "submit",
      bucket,
      url: clean,
      domain,
      headline: rawTitle.slice(0, 300),
      note: note || null,
    });
    if (sigErr) throw new Error(`signal insert failed: ${sigErr.message}`);

    if (existing) {
      return res.status(200).json({
        ok: true,
        already_present: true,
        learned: true,
        message: "Already in your feed — recorded as a preference signal.",
      });
    }

    // One small model call: clean the headline, write a teaser, pick a tag.
    const system = `You process a single article a user manually submitted because their tracker missed it.
Topic area: "${BUCKETS.find((b) => b.id === bucket).label}".
Work ONLY from the metadata given. Do not invent facts, figures, or URLs.

Return ONLY a JSON object (no fences, no preamble):
{
  "headline": "plain factual rewrite of the title; strip clickbait and publisher suffixes",
  "teaser": "1-2 sentence summary from the description; if the description is empty or useless, restate the headline neutrally",
  "tag": one of ${TAGS.map((t) => `"${t}"`).join(", ")}
}`;

    let labelled = {};
    try {
      const raw = await llm(system, {
        title: rawTitle,
        description: meta.description,
        source,
        user_note: note,
      }, 400, { json: true });
      const parsed = parseJsonish(raw);
      labelled = Array.isArray(parsed) ? (parsed[0] || {}) : (parsed || {});
    } catch (err) {
      console.error("submit labelling failed, storing raw:", err.message);
    }

    const row = {
      bucket,
      headline: labelled.headline || rawTitle.slice(0, 300),
      teaser: labelled.teaser || meta.description || note || "Added manually.",
      summary: "",
      tag: TAGS.includes(labelled.tag) ? labelled.tag : "Other",
      source,
      url: clean,
      is_blog: false,
      published_at,
      found_on: pacificToday(),
      is_manual: true,
      dedupe_key: key,
    };

    const { data, error } = await supabase
      .from("stories")
      .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("id, headline, bucket, source")
      .maybeSingle();

    if (error) throw new Error(`insert failed: ${error.message}`);

    return res.status(200).json({
      ok: true,
      story: data,
      learned: true,
      ...(fetchNote ? { warning: `${fetchNote} — saved with limited detail` } : {}),
    });
  } catch (err) {
    console.error("Submit failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
