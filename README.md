# Backbone — data center intel tracker

A daily-refreshing news tracker across 7 beats: HPE Networking (Juniper + Aruba), Cisco, Arista,
Silicon & Industry Trends, AI Industry & Broader Trends, Space Data Centers, and Networking
Standards & Innovations.

Stories come from ~30 RSS feeds (trade press, vendor newsrooms, hyperscaler engineering blogs)
rather than a paid web-search API, so sourcing costs nothing and has no quota. An LLM is used only
to judge which stories matter and to write the copy.

---

## How it works

**Finding** — `api/refresh.js` fetches every feed for a beat, then filters mechanically: blocked
domains, junk title patterns (listicles, webinars, stock tips), a recency window, and a keyword
match. Survivors are scored by source tier, how many separate outlets filed the same story
(corroboration), and recency.

**Deduping before spending tokens** — candidate URLs are hashed and checked against what's already
stored. Anything you already have is dropped before the model sees it, which on a normal day is most
of the feed.

**Choosing** — the top 8 candidates per beat go to the model, which picks at most 4 genuinely
significant ones, cleans the headline, and assigns a tag. If a beat is quiet, one well-sourced blog
or analysis piece is kept instead and labelled "Blog post".

**Summaries are lazy** — the 4–6 sentence summary is written the first time you expand a story
(`api/summarize.js`), then cached in the row forever. Most stories are never expanded, so this is
where most of the token savings come from.

**Learning** — paste a URL it missed and `api/submit.js` adds it to your feed and records a signal:
that domain becomes trusted, its distinctive terms join the beat's keyword filter, and the headline
becomes a few-shot example of what you consider significant. "Not relevant" (`api/feedback.js`)
does the reverse — three strikes and a domain is filtered out entirely.

**Chunked refresh** — Vercel Hobby caps functions at 60 seconds and the Groq free tier caps tokens
per minute, so a refresh processes 3 beats per call. The frontend loops until done and shows
progress. Because a once-daily Hobby cron can't complete the loop, the page also refreshes itself on
load if it's been more than 20 hours.

---

## Setup

### 1. Supabase

SQL Editor → New query → paste `migration.sql` → Run. It adds two columns to `stories`, creates the
`signals` table, moves the anon writes into security-definer functions (the old policy let any
visitor modify any column), and sets `found_on` to US Pacific.

Your existing stories are preserved.

### 2. Groq

console.groq.com → sign up (free, no credit card) → API Keys → create one.

### 3. Vercel environment variables

| Name | Value |
|---|---|
| `LLM_API_KEY` | your Groq API key |
| `SUPABASE_URL` | your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service_role key |
| `REFRESH_SECRET` | any password you make up |
| `CRON_SECRET` | the SAME value as `REFRESH_SECRET` |

Remove `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `GEMINI_MODEL` — no longer used.

Optional, to switch LLM provider without touching code:

| Name | Default |
|---|---|
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` |
| `LLM_MODEL` | `llama-3.3-70b-versatile` |

Any OpenAI-compatible endpoint works — Cerebras, Mistral, OpenRouter, or a paid key.

### 4. Frontend values

Near the top of the `<script>` block in `public/index.html`:

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-public-key";   // anon, NOT service_role
const REFRESH_SECRET = "same-value-as-vercel";
```

### 5. Deploy

Commit and push. Vercel redeploys automatically.

---

## First run

Expect two or three feed URLs to be dead — publishers move and retire them constantly. The refresh
response includes a `feed_health` array listing every feed that failed or returned nothing, and the
frontend logs it to the browser console. Fix by editing the URL in `api/_lib/sources.js`.

To pull in what the feeds currently hold (roughly the last 2–3 weeks), visit once:

```
/api/refresh?mode=backfill&cursor=0&secret=YOUR_SECRET
```

then `cursor=3` and `cursor=6`. RSS doesn't reach further back than that — deep history would need a
paid search API for a one-time run.

---

## Tuning

Everything worth adjusting is at the top of `api/refresh.js`:

- `PER_BUCKET` — stories kept per beat per run (4)
- `SHORTLIST` — candidates that reach the model (8)
- `DAILY_WINDOW` — days back on a normal refresh (5)
- `CHUNK` — beats per invocation (3; lower it if you see timeouts)

Feeds, keywords, blocked domains and junk title patterns live in `api/_lib/sources.js`.

---

## Notes

- Feeds give a title and a short description, not the article body, so teasers are thinner than
  full-text summarization would produce. The lazy summary endpoint does try to fetch the real page,
  which works for most trade press and fails on paywalls.
- `REFRESH_SECRET` stops random visitors triggering API calls. It sits in the frontend, so treat it
  as a speed bump, not real security.
- A quiet beat shows a labelled blog post rather than nothing.
