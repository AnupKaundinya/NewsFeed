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

const EMBED_MODEL = process.env.EMBED_MODEL || "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const BATCH = 100;              // the API's per-request limit
const DIMS = 768;               // plenty for headline-sized text, and cheaper to compare
const MAX_EMBED = 160;          // candidates embedded per beat; keyword hits go first
export const RELEVANT_CAP = 25; // survivors handed on to scoring
// Margin by which positives must beat negatives. Tune with ?mode=preview.
const MARGIN = Number(process.env.RELEVANCE_MARGIN || 0);

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
async function embed(texts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
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
      throw new Error(`embedding ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const vecs = (json.embeddings || []).map((e) => e.values);
    if (vecs.length !== chunk.length) throw new Error("embedding count mismatch");
    out.push(...vecs);
  }
  return out;
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
 * Sets c.relevance (higher is better) on every candidate it keeps.
 * Returns { kept, mode, scored } — scored has every candidate's numbers, for ?mode=preview.
 */
export async function rankByRelevance(bucket, candidates, { liked = [], disliked = [], antiProfile = [] }) {
  // Keyword hits first, then newest, so the cap trims the least likely items.
  const pool = [...candidates]
    .sort((a, b) => (b.kwHit - a.kwHit) || String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, MAX_EMBED);

  try {
    const posTexts = [bucket.profile, ...liked];
    const negTexts = [...antiProfile, ...disliked];
    const vecs = await embed([...posTexts, ...negTexts, ...pool.map(candidateText)]);
    const profileVec = vecs[0];
    const likedVecs = vecs.slice(1, posTexts.length);
    const negVecs = vecs.slice(posTexts.length, posTexts.length + negTexts.length);
    const itemVecs = vecs.slice(posTexts.length + negTexts.length);

    const scored = pool.map((c, i) => {
      const v = itemVecs[i];
      // A saved story close to this one counts nearly as much as the profile.
      const pos = Math.max(cosine(v, profileVec), 0.95 * maxSim(v, likedVecs));
      const neg = maxSim(v, negVecs);
      // Ahead of the negatives: keep the lead. Behind: fall twice as fast.
      const rel = pos - Math.max(0, neg - pos) + (c.kwHit ? 0.02 : 0);
      return { c, pos, neg, rel, keep: pos - neg > MARGIN };
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
        pos: round(s.pos), neg: round(s.neg), rel: round(s.rel), kept: kept.includes(s.c),
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
