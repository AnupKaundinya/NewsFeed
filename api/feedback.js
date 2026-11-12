import { supabase, domainOf, authorize } from "./_lib/util.js";

// Google News links all resolve to news.google.com, so older stories saved before
// the domain column existed have no usable domain — record none rather than
// penalizing Google News as a whole.
function publisherDomain(story) {
  if (story.domain) return story.domain;
  const d = domainOf(story.url);
  return d === "news.google.com" ? null : d;
}

// Hides a story for the signed-in person (or undoes it). When the admin does
// it, it also records the negative signal that down-weights the domain and
// steers what the refresh picks for everyone.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await authorize(req, res);
  if (!auth) return;
  if (!auth.user) return res.status(400).json({ ok: false, error: "Feedback needs a signed-in person" });

  const { story_id, dismissed = true } = req.body || {};
  if (!story_id) return res.status(400).json({ ok: false, error: "story_id is required" });

  try {
    const { data: story, error: readErr } = await supabase
      .from("stories")
      .select("id, bucket, url, domain, headline")
      .eq("id", story_id)
      .maybeSingle();

    if (readErr) throw new Error(readErr.message);
    if (!story) return res.status(404).json({ ok: false, error: "Story not found" });

    // Hides it for this person only.
    const { error: updErr } = await supabase
      .from("story_state")
      .upsert(
        { user_id: auth.user.id, story_id, dismissed: !!dismissed, updated_at: new Date().toISOString() },
        { onConflict: "user_id,story_id" }
      );
    if (updErr) throw new Error(updErr.message);

    // Only the admin's verdicts train the shared filter; for everyone else
    // "not relevant" just hides the story for them.
    if (!auth.admin) return res.status(200).json({ ok: true, dismissed: !!dismissed, learned: false });

    if (dismissed) {
      const { error: sigErr } = await supabase.from("signals").insert({
        kind: "dismiss",
        bucket: story.bucket,
        url: story.url,
        domain: publisherDomain(story),
        headline: story.headline,
        user_id: auth.user.id,
      });
      if (sigErr) throw new Error(sigErr.message);
    } else {
      // Undo: drop the most recent dismiss signal for this story.
      await supabase.from("signals").delete()
        .eq("kind", "dismiss").eq("url", story.url).eq("user_id", auth.user.id);
    }

    return res.status(200).json({ ok: true, dismissed: !!dismissed });
  } catch (err) {
    console.error("Feedback failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
