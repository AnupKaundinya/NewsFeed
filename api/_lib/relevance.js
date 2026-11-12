// ===========================================================================
// Relevance by meaning, not letters.
//
// Every candidate is embedded and compared with:
//   - the beat's written profile, and headlines you saved or submitted (positives)
//   - a shared list of off-topic descriptions, and headlines you dismissed (negatives)
// A candidate stays only if it sits closer to the positives than the negatives;
// the survivors are ranked by how far ahead they are.
//
// Without GEMINI_API_KEY, or if the embedding call fails, this falls back to
// whole-word keyword matching, so a refresh never fails because of it.
// ===========================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const EMBED_MODEL = process.env.EMBED_MODEL || "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const BATCH = 100;              // the API's per-request limit
const DIMS = 768;               // plenty for headline-sized text, and cheaper to compare
// Gemini's free tier counts every text as one request, 100 a minute. A beat
// spends at most MAX_EMBED on candidates plus a few on your liked/dismissed
// headlines; the fixed profile texts come pre-computed (profile-vectors.json).
const MAX_EMBED = 40;           // candidates embedded per beat; keyword hits go first
const MAX_SIGNALS = 4;          // liked and dismissed headlines embedded per beat, each
export const RELEVANT_CAP = 25; // survivors handed on to scoring
// Margin by which positives must beat negatives. Tune with ?mode=preview.
// 0.035 came from a live run: real Cisco switching/routing stories led their
// nearest off-topic line by 0.04-0.09, security and campus posts by 0.02-0.035.
const MARGIN = Number(process.env.RELEVANCE_MARGIN || 0.035);
// How far behind another beat's best match an item may be and still stay here.
const TIE = 0.01;

// --- whole-word keywords ----------------------------------------------------
// "aci" must not match "capacity". A trailing "*" marks a prefix ("load balanc*").
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function keywordMatcher(keywords) {
  const parts = keywords.map((k) => {
    const prefix = k.endsWith("*");
    const word = escapeRe(prefix ? k.slice(0, -1) : k);
    return prefix ? `\\b${word}` : `\\b${word}(?:s|es)?\\b`;
  });
  if (!parts.length) return () => false;
  const re = new RegExp(parts.join("|"), "i");
  return (text) => re.test(text);
}

// --- embeddings -------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const textKey = (text) => createHash("sha1").update(`${EMBED_MODEL}:${DIMS}:${text}`).digest("hex");

// Fixed texts (beat profiles, the off-topic list), embedded ahead of time by
// scripts/embed-profiles.mjs. A text edited since then just gets embedded live.
let stored = {};
try {
  stored = JSON.parse(readFileSync(new URL("./profile-vectors.json", import.meta.url), "utf8"));
} catch { /* not generated yet */ }

export async function embed(texts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const out = new Array(texts.length);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = stored[textKey(t)];
    if (hit) out[i] = hit;
    else todo.push(i);
  });
  for (let n = 0; n < todo.length; n += BATCH) {
    const idx = todo.slice(n, n + BATCH);
    const vecs = await embedBatch(idx.map((i) => texts[i]), key);
    idx.forEach((i, k) => { out[i] = vecs[k]; });
  }
  return out;
}

async function embedBatch(chunk, key, retried = false) {
  {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        requests: chunk.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: text.slice(0, 2000) }] },
          taskType: "SEMANTIC_SIMILARITY",
          outputDimensionality: DIMS,
        })),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Per-minute limit: wait it out once if that fits in the function's time.
      const wait = Number((body.match(/retry in ([\d.]+)s/i) || [])[1]);
      if (res.status === 429 && !retried && wait && wait <= 30) {
        await sleep(wait * 1000 + 500);
        return embedBatch(chunk, key, true);
      }
      const reason = (body.match(/"message":\s*"([^"\\]{0,160})/) || [])[1] || body.slice(0, 160);
      throw new Error(`embedding ${res.status}: ${reason}`);
    }
    const json = await res.json();
    const vecs = (json.embeddings || []).map((e) => e.values);
    if (vecs.length !== chunk.length) throw new Error("embedding count mismatch");
    return vecs;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const maxSim = (v, set) => set.reduce((m, s) => Math.max(m, cosine(v, s)), 0);
const round = (n) => Math.round(n * 1000) / 1000;

export const candidateText = (c) => `${c.title}. ${String(c.body || "").slice(0, 300)}`;

/**
 * Filter and rank a beat's candidates by meaning.
 *
 * Profiles are lists of short, single-topic lines; an item's score against a
 * group is its similarity to the closest line. It stays on this beat only if:
 *   - this beat is its best match among all beats (so a generic data center
 *     build goes to the AI beat, not to HPE), within TIE of the best, and
 *   - it's closer to this beat than to anything off-topic, by MARGIN.
 * Sets c.relevance on every candidate it keeps.
 * Returns { kept, mode, scored } — scored has every candidate's numbers, for ?mode=preview.
 */
export async function rankByRelevance(bucket, candidates, { liked = [], disliked = [], antiProfile = [], beats = [] }) {
  // Keyword hits first, then newest, so the cap trims the least likely items.
  const pool = [...candidates]
    .sort((a, b) => (b.kwHit - a.kwHit) || String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, MAX_EMBED);

  try {
    const others = beats.filter((b) => b.id !== bucket.id);
    const groups = [
      ["own", [...bucket.profile, ...liked.slice(0, MAX_SIGNALS)]],
      ["anti", [...antiProfile, ...disliked.slice(0, MAX_SIGNALS)]],
      ...others.map((b) => [b.id, b.profile]),
    ];
    const fixed = groups.flatMap(([, texts]) => texts);
    const vecs = await embed([...fixed, ...pool.map(candidateText)]);
    const groupVecs = {};
    let at = 0;
    for (const [name, texts] of groups) {
      groupVecs[name] = vecs.slice(at, at + texts.length);
      at += texts.length;
    }
    const itemVecs = vecs.slice(at);

    const scored = pool.map((c, i) => {
      const v = itemVecs[i];
      const own = maxSim(v, groupVecs.own);
      const anti = maxSim(v, groupVecs.anti);
      let other = 0, otherBeat = null;
      for (const b of others) {
        const sim = maxSim(v, groupVecs[b.id]);
        if (sim > other) { other = sim; otherBeat = b.id; }
      }
      const rel = own - Math.max(anti, other) + (c.kwHit ? 0.01 : 0);
      const keep = own - anti > MARGIN && own >= other - TIE;
      return { c, own, anti, other, otherBeat, rel, keep };
    });

    const kept = scored
      .filter((s) => s.keep)
      .sort((a, b) => b.rel - a.rel)
      .slice(0, RELEVANT_CAP)
      .map((s) => { s.c.relevance = s.rel; return s.c; });

    return {
      kept,
      mode: "embeddings",
      scored: scored.map((s) => ({
        title: s.c.title, source: s.c.source, keyword: !!s.c.kwHit,
        own: round(s.own), anti: round(s.anti), other: round(s.other), other_beat: s.otherBeat,
        rel: round(s.rel), kept: kept.includes(s.c),
      })),
    };
  } catch (err) {
    console.warn(`relevance fell back to keywords for ${bucket.id}: ${err.message}`);
    const kept = candidates.filter((c) => c.kwHit);
    return {
      kept,
      mode: "keywords",
      error: String(err.message || err).slice(0, 200),
      scored: candidates.map((c) => ({ title: c.title, source: c.source, keyword: !!c.kwHit, kept: !!c.kwHit })),
    };
  }
}
