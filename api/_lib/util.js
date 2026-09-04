import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role: bypasses RLS, backend only
);

// --- LLM -------------------------------------------------------------------
// Any OpenAI-compatible provider. Defaults to Groq's free tier.
// To switch: set LLM_BASE_URL + LLM_MODEL in Vercel. No code change.
const LLM_BASE = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1";
const LLM_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

export async function llm(system, user, maxTokens = 1600) {
  if (!process.env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set");

  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return (json.choices?.[0]?.message?.content || "").trim();
}

export function parseJsonish(raw) {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Models occasionally wrap the array in prose. Grab the outermost array.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

// --- Dates / ids -----------------------------------------------------------
export function pacificToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function dedupeKey(bucket, url) {
  return crypto.createHash("sha256").update(`${bucket}::${normalizeUrl(url)}`).digest("hex");
}

// Strip tracking params so the same article via two paths dedupes correctly.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source)/i.test(p)) u.searchParams.delete(p);
    }
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// --- Text ------------------------------------------------------------------
export function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(("a an the and or of for to in on at by with from as is are was were be been " +
  "its it this that these those new news says said report reports will can could may")
  .split(" "));

// Distinctive terms from a headline — used for corroboration matching and
// for the terms a submitted story teaches the keyword filter.
export function significantTerms(title) {
  return [...new Set(
    stripHtml(title).toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  )];
}

export function titleOverlap(a, b) {
  const A = new Set(significantTerms(a));
  const B = new Set(significantTerms(b));
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

// --- Feeds -----------------------------------------------------------------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v["#text"] || "";
}

// Google News titles arrive as "Headline - Publisher".
function splitSource(title, fallback) {
  const m = /^(.*)\s+[-–—]\s+([^-–—]{2,45})$/.exec(title || "");
  return m
    ? { title: m[1].trim(), source: m[2].trim() }
    : { title: (title || "").trim(), source: fallback };
}

export async function readFeed(feed) {
  let xml;
  try {
    const res = await fetch(feed.url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; BackboneTracker/2.0; +personal-use)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { url: feed.url, ok: false, error: `HTTP ${res.status}`, items: [] };
    xml = await res.text();
  } catch (err) {
    return { url: feed.url, ok: false, error: err.name === "TimeoutError" ? "timeout" : err.message, items: [] };
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return { url: feed.url, ok: false, error: `unparseable: ${err.message}`, items: [] };
  }

  const channel = doc?.rss?.channel;
  const feedTitle = stripHtml(textOf(channel?.title) || textOf(doc?.feed?.title) || domainOf(feed.url));

  const rss = asArray(channel?.item).map((it) => ({
    rawTitle: stripHtml(textOf(it.title)),
    url: typeof it.link === "string" ? it.link : it.link?.["@_href"] || textOf(it.guid) || "",
    date: it.pubDate || it["dc:date"] || null,
    body: stripHtml(it.description || it["content:encoded"] || ""),
  }));

  const atom = asArray(doc?.feed?.entry).map((e) => ({
    rawTitle: stripHtml(textOf(e.title)),
    url: asArray(e.link).find((l) => !l["@_rel"] || l["@_rel"] === "alternate")?.["@_href"] || "",
    date: e.updated || e.published || null,
    body: stripHtml(textOf(e.summary) || textOf(e.content)),
  }));

  const items = [...rss, ...atom]
    .filter((i) => i.rawTitle && i.url && /^https?:/i.test(i.url))
    .map((i) => {
      const { title, source } = splitSource(i.rawTitle, feedTitle);
      const d = i.date ? new Date(i.date) : null;
      return {
        title,
        source,
        url: normalizeUrl(i.url),
        domain: domainOf(i.url),
        body: i.body.slice(0, 700),
        published_at: d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null,
        tier: feed.tier,
        is_blog: feed.kind === "blog",
      };
    });

  return { url: feed.url, ok: true, items };
}
