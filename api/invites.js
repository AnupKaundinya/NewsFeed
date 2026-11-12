import { supabase, authorize } from "./_lib/util.js";

// The invite list, for the admin's People panel.
//   GET                          everyone invited, and whether they've signed in
//   POST   { email, send }       invite; send=true also emails them a sign-in link
//   DELETE { email }             uninvite, delete their account and their own lists
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function accounts() {
  const byEmail = new Map();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) break;
  }
  return byEmail;
}

export default async function handler(req, res) {
  const auth = await authorize(req, res, { adminOnly: true });
  if (!auth) return;

  try {
    if (req.method === "GET") {
      const [{ data, error }, users] = await Promise.all([
        supabase.from("allowed_emails").select("email, is_admin, added_at").order("added_at", { ascending: true }),
        accounts(),
      ]);
      if (error) throw new Error(error.message);
      const people = (data || []).map((p) => {
        const u = users.get(p.email);
        return { ...p, signed_in_at: u?.last_sign_in_at || null, has_account: !!u };
      });
      return res.status(200).json({ ok: true, people });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL.test(email)) return res.status(400).json({ ok: false, error: "Enter a valid email address" });

    if (req.method === "POST") {
      const { error } = await supabase.from("allowed_emails")
        .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });
      if (error) throw new Error(error.message);

      let emailed = false, warning = null;
      if (req.body?.send) {
        const origin = req.headers.origin || `https://${req.headers.host}`;
        const { error: sendErr } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: `${origin}/` });
        if (sendErr) {
          // Already has an account, or Supabase's email isn't set up — they're still invited.
          warning = /already been registered/i.test(sendErr.message)
            ? "They already have an account; they can sign in from the page."
            : `Invited, but the email didn't send (${sendErr.message}). Share the site link instead.`;
        } else emailed = true;
      }
      return res.status(200).json({ ok: true, email, emailed, ...(warning ? { warning } : {}) });
    }

    if (req.method === "DELETE") {
      const { data: row, error } = await supabase.from("allowed_emails")
        .select("is_admin").eq("email", email).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return res.status(404).json({ ok: false, error: "Not on the invite list" });
      if (row.is_admin) return res.status(400).json({ ok: false, error: "Admins can't be removed here" });

      const user = (await accounts()).get(email);
      if (user) {
        // Deleting the account drops their read/saved/hidden rows and signs them out.
        const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
        if (delErr) throw new Error(delErr.message);
      }
      const { error: rmErr } = await supabase.from("allowed_emails").delete().eq("email", email);
      if (rmErr) throw new Error(rmErr.message);
      return res.status(200).json({ ok: true, email, removed_account: !!user });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error("Invites failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
