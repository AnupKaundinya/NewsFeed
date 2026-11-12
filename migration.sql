-- ===========================================================================
-- Backbone — migration to the RSS + Groq pipeline
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run on your existing table; your current stories are preserved.
-- ===========================================================================

-- 1. New columns on stories -------------------------------------------------

alter table stories add column if not exists is_manual boolean not null default false;
alter table stories add column if not exists dismissed boolean not null default false;

-- summary is now generated lazily (on first expand), so it must allow empty.
alter table stories alter column summary drop not null;
alter table stories alter column summary set default '';

-- found_on should be YOUR day, not UTC's day.
alter table stories
  alter column found_on
  set default (now() at time zone 'America/Los_Angeles')::date;

create index if not exists stories_dismissed_idx on stories (dismissed);


-- 2. Learning signals ------------------------------------------------------
-- One table for both directions. kind = 'submit' (you added a missed story)
-- or 'dismiss' (you marked one irrelevant). refresh.js reads this to weight
-- domains, extend keyword filters, and build few-shot examples.

create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('submit', 'dismiss')),
  bucket text,
  url text,
  domain text,
  headline text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists signals_kind_idx on signals (kind, created_at desc);
create index if not exists signals_domain_idx on signals (domain);

alter table signals enable row level security;
-- No anon policies: only the backend service role touches this table.


-- 3. Lock down the anon key ------------------------------------------------
-- The old policy was `using (true) with check (true)`, which let any visitor
-- modify any column of any row. Postgres RLS can't restrict by column, so
-- reads stay open and the two writes you actually need move into security-
-- definer functions that can only ever touch is_read / dismissed.

drop policy if exists "Public can mark stories read" on stories;
drop policy if exists "Public can read stories" on stories;

create policy "Public can read stories"
  on stories for select
  using (true);

create or replace function mark_story_read(story_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update stories set is_read = true where id = story_id;
$$;

create or replace function set_story_dismissed(story_id uuid, value boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update stories set dismissed = value where id = story_id;
$$;

grant execute on function mark_story_read(uuid) to anon;
grant execute on function set_story_dismissed(uuid, boolean) to anon;


-- 4. Saved articles --------------------------------------------------------
-- A bookmark you set by hand. saved_at drives the Saved view's order, which is
-- when you saved it, not when it was published.

alter table stories add column if not exists saved boolean not null default false;
alter table stories add column if not exists saved_at timestamptz;

create index if not exists stories_saved_idx on stories (saved, saved_at desc);

create or replace function set_story_saved(story_id uuid, value boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update stories
     set saved = value,
         saved_at = case when value then now() else null end
   where id = story_id;
$$;

grant execute on function set_story_saved(uuid, boolean) to anon;


-- 5. Cache the generated long summary --------------------------------------
-- Called by /api/summarize with the service role, so no anon grant needed.

create or replace function save_story_summary(story_id uuid, body text)
returns void
language sql
security definer
set search_path = public
as $$
  update stories set summary = body where id = story_id;
$$;


-- 6. Publisher domain ------------------------------------------------------
-- Google News stories link to news.google.com, so the publisher's domain is
-- stored separately. Dismiss signals use it to down-weight the real source.

alter table stories add column if not exists domain text;


-- ===========================================================================
-- 7. Multiple users (run once, after sections 1-6)
--
-- The story pool stays shared. Read / saved / dismissed move to story_state,
-- one row per person per story. Sign-in is a Supabase email magic link, and
-- only emails in allowed_emails can create an account.
--
-- Invite someone:   insert into allowed_emails (email) values ('friend@example.com');
-- Remove someone:   delete from allowed_emails where email = 'friend@example.com';
--                   (and delete their user under Authentication > Users)
-- ===========================================================================

create table if not exists allowed_emails (
  email text primary key check (email = lower(email)),
  is_admin boolean not null default false,
  added_at timestamptz not null default now()
);
alter table allowed_emails enable row level security;
-- No policies: only SQL and the service role read it.

-- >>> CHANGE THIS to your own email before running. You become the admin and
-- >>> inherit the current read / saved / dismissed state.
insert into allowed_emails (email, is_admin)
values (lower('you@example.com'), true)
on conflict (email) do update set is_admin = true;

-- Refuse sign-ups from emails not on the list.
create or replace function enforce_invite_list()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from allowed_emails where email = lower(new.email)) then
    raise exception 'not_invited';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_invite_list on auth.users;
create trigger enforce_invite_list
  before insert on auth.users
  for each row execute function enforce_invite_list();

-- Per-person state.
create table if not exists story_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  story_id uuid not null references stories (id) on delete cascade,
  is_read boolean not null default false,
  saved boolean not null default false,
  saved_at timestamptz,
  dismissed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, story_id)
);
create index if not exists story_state_saved_idx on story_state (saved, saved_at desc);

alter table story_state enable row level security;
drop policy if exists "Own state" on story_state;
create policy "Own state"
  on story_state for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The admin's first sign-in carries over the state stored on stories so far.
create or replace function adopt_legacy_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from allowed_emails where email = lower(new.email) and is_admin) then
    insert into story_state (user_id, story_id, is_read, saved, saved_at, dismissed)
    select new.id, id, is_read, saved, saved_at, dismissed
      from stories
     where is_read or saved or dismissed
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists adopt_legacy_state on auth.users;
create trigger adopt_legacy_state
  after insert on auth.users
  for each row execute function adopt_legacy_state();

-- Who gave each piece of feedback.
alter table signals add column if not exists user_id uuid references auth.users (id) on delete set null;

-- Stories are for signed-in people only now.
drop policy if exists "Public can read stories" on stories;
drop policy if exists "Signed-in can read stories" on stories;
create policy "Signed-in can read stories"
  on stories for select
  to authenticated
  using (true);

-- The old shared-state functions would let anyone flip the global columns.
drop function if exists mark_story_read(uuid);
drop function if exists set_story_dismissed(uuid, boolean);
drop function if exists set_story_saved(uuid, boolean);

-- When the feed was last refreshed, by anyone, so pages don't all refresh at once.
create table if not exists app_meta (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table app_meta enable row level security;
drop policy if exists "Signed-in can read meta" on app_meta;
create policy "Signed-in can read meta"
  on app_meta for select
  to authenticated
  using (true);

-- People can see their own invite row (the page uses is_admin to label buttons).
drop policy if exists "Read own invite" on allowed_emails;
create policy "Read own invite"
  on allowed_emails for select
  to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

-- The admin's user ids, for the refresh: only the admin's saves teach it.
create or replace function admin_user_ids()
returns table (id uuid)
language sql
security definer
set search_path = public
as $$
  select u.id
    from auth.users u
    join allowed_emails a on a.email = lower(u.email)
   where a.is_admin;
$$;
revoke execute on function admin_user_ids() from public, anon, authenticated;
