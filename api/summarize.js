import { supabase, llm, stripHtml } from "./_lib/util.js";

// Long summaries are generated on first expand, not at refresh time — most
// stories are never opened, so this is where the token savings come from.
// Once generated it's cached in the row and never regenerated.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expected = process.env.REFRESH_SECRET;
  if (expected && req.headers["x-refresh-secret"] !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { story_id } = req.body || {};
  if (!story_id) return res.status(400).json({ ok: false, error: "story_id is required" });

  try {
    const { data: story, error } = await supabase
      .from("stories")
      .select("id, headline, teaser, source, url, summary, bucket")
      .eq("id", story_id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!story) return res.status(404).json({ ok: false, error: "Story not found" });
    if (story.summary && story.summary.trim()) {
      return res.status(200).json({ ok: true, summary: story.summary, cached: true });
    }

    // Try the real page first — a proper summary beats one built from a teaser.
    let pageText = "";
    try {
      const r = await fetch(story.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(9000),
        redirect: "follow",
      });
      if (r.ok) {
        const html = (await r.text()).slice(0, 300000);
        pageText = stripHtml(
          html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
            .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        ).slice(0, 6000);
      }
    } catch {
      // paywalled or blocked — fall back to the teaser
    }

    const system = `You write briefing summaries for a data center networking professional.
Write 4-6 sentences: what happened, the technical specifics that matter, and why it's relevant to
someone working on data center networking.

Use ONLY the material provided. Do not add figures, dates, product names, or claims that are not
present. If the material is thin, write a shorter accurate summary rather than padding it. No
preamble, no bullet points, no headings — plain prose only.`;

    const summary = (await llm(system, {
      headline: story.headline,
      teaser: story.teaser,
      source: story.source,
      article_text: pageText || null,
    }, 600)).replace(/^(summary|briefing)\s*:\s*/i, "").trim();

    if (!summary) throw new Error("model returned an empty summary");

    const { error: saveErr } = await supabase
      .from("stories")
      .update({ summary })
      .eq("id", story_id);
    if (saveErr) throw new Error(saveErr.message);

    return res.status(200).json({
      ok: true,
      summary,
      cached: false,
      from_full_text: !!pageText,
    });
  } catch (err) {
    console.error("Summarize failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
