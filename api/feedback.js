import { supabase, domainOf } from "./_lib/util.js";

// Marks a story not-relevant (or undoes it) and records the negative signal
// that down-weights its domain and steers future selection.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expected = process.env.REFRESH_SECRET;
  if (expected && req.headers["x-refresh-secret"] !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { story_id, dismissed = true } = req.body || {};
  if (!story_id) return res.status(400).json({ ok: false, error: "story_id is required" });

  try {
    const { data: story, error: readErr } = await supabase
      .from("stories")
      .select("id, bucket, url, headline")
      .eq("id", story_id)
      .maybeSingle();

    if (readErr) throw new Error(readErr.message);
    if (!story) return res.status(404).json({ ok: false, error: "Story not found" });

    const { error: updErr } = await supabase
      .from("stories")
      .update({ dismissed: !!dismissed })
      .eq("id", story_id);
    if (updErr) throw new Error(updErr.message);

    if (dismissed) {
      const { error: sigErr } = await supabase.from("signals").insert({
        kind: "dismiss",
        bucket: story.bucket,
        url: story.url,
        domain: domainOf(story.url),
        headline: story.headline,
      });
      if (sigErr) throw new Error(sigErr.message);
    } else {
      // Undo: drop the most recent dismiss signal for this story.
      await supabase.from("signals").delete().eq("kind", "dismiss").eq("url", story.url);
    }

    return res.status(200).json({ ok: true, dismissed: !!dismissed });
  } catch (err) {
    console.error("Feedback failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
