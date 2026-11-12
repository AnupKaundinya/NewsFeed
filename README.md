# NewsFeed

A daily brief on data center networking. Reads ~30 sources, picks the few
stories worth knowing, and writes a summary when you open one.

**[Live site](https://news-agg-v2.vercel.app/)**

![NewsFeed](docs/screenshot.png)

Seven beats — HPE/Juniper, Cisco, Arista, merchant silicon, AI infrastructure,
orbital data centers, and networking standards (RoCE, Ultra Ethernet, IEEE,
OCP). Three or four stories each, sorted by publish date.

## How it works

RSS from trade press, vendor newsrooms and engineering blogs, plus a Google
News query per beat. Items matching that beat's keywords go to an LLM, which
picks the three or four most significant and tags each one. Summaries are
written on demand, the first time you open a story.

Dismissing a story records the source, tag and beat as a negative signal.
Submitting a URL the pipeline missed marks that source trusted, so future
items from it rank higher.

## Design notes

**Refresh runs one beat per request.** Vercel's Hobby tier kills a function at
60 seconds and Groq's free tier caps tokens per minute — seven beats in one
call fits neither. The client walks the beats with a cursor and shows progress.

**Dedupe happens before the LLM, not after.** Candidates are checked against
stored URLs first, so re-runs cost nothing in tokens. The stories table doubles
as the ledger, which is also why read stories are never deleted.

**Summaries are lazy.** Writing all 28 upfront would blow the daily token
budget on stories you'd never open. One call per story, on first click.

**Relevance is judged by meaning, not keywords.** Every new candidate is
embedded (Gemini) and compared with its beat's written profile and the stories
you saved or submitted, and against a shared list of off-topic descriptions
(campus Wi-Fi, security, events…) and the stories you dismissed. It stays only
if it sits closer to the first group. Keywords match whole words now and only
give a small boost — or do the filtering on their own if `GEMINI_API_KEY` is
missing or the embedding call fails. `/api/refresh?mode=preview&cursor=N`
returns one beat's scores without calling the LLM or storing anything; set
`RELEVANCE_MARGIN` to tighten or loosen the cut.

## Stack

Vanilla JS frontend, no build step. Vercel serverless functions. Supabase for
storage. Groq for inference (`openai/gpt-oss-20b`).

Runs free on all three: Groq's free tier covers ~30 calls a day, Supabase's
500 MB holds years of stories at a couple of KB each, and the whole thing fits
in Hobby's function limits.

<details>
<summary><b>Running it yourself</b></summary>

**1.** Create a Supabase project and run `migration.sql` in the SQL Editor.

**2.** Get a free API key from [console.groq.com](https://console.groq.com).

**3.** Import the repo into Vercel and set:

| Variable | Where it comes from |
| --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | same page, the `service_role` key |
| `GROQ_API_KEY` | console.groq.com |
| `LLM_MODEL` | `openai/gpt-oss-20b` |
| `REFRESH_SECRET` | any random string |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key (embeddings for relevance) |

**4.** Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of the script
in `public/index.html`. The anon key is public by design; `REFRESH_SECRET` is
not, so it stays out of the page.

Deploy. The first time you refresh, the page asks for `REFRESH_SECRET` and keeps
it in that browser. After that it refreshes itself on open if the last run was
over 20 hours ago.

**Backfill** — a normal refresh looks back 5 days. To reach further:

```
/api/refresh?mode=backfill&cursor=6&secret=YOUR_SECRET
```

21-day window, up to 8 stories per beat. `cursor` is the beat index, 0–6.

**Adding a source** — feeds and keywords live in `api/_lib/sources.js`, one
array of each per beat.

```
api/
  refresh.js      fetch, filter, select
  summarize.js    on-demand summaries
  submit.js       manual story submission
  feedback.js     records dismissals
  _lib/
    sources.js    feeds and keywords per beat
    util.js       Groq client, RSS parsing, helpers
public/
  index.html      the whole frontend
migration.sql     schema
vercel.json       cron + routing
```

</details>
