// Pre-compute embeddings for the fixed texts (beat profiles, off-topic list)
// so a refresh doesn't spend free-tier requests on them every time.
// Rerun after editing a profile in api/_lib/sources.js:
//   GEMINI_API_KEY=... node scripts/embed-profiles.mjs
import { writeFileSync } from "node:fs";
import { BUCKETS, ANTI_PROFILE } from "../api/_lib/sources.js";
import { embed, textKey } from "../api/_lib/relevance.js";

const texts = [...BUCKETS.flatMap((b) => b.profile), ...ANTI_PROFILE];
const vecs = await embed(texts);
const out = {};
texts.forEach((t, i) => { out[textKey(t)] = vecs[i].map((x) => Math.round(x * 1e5) / 1e5); });
writeFileSync(new URL("../api/_lib/profile-vectors.json", import.meta.url), JSON.stringify(out));
console.log(`wrote ${texts.length} vectors`);
