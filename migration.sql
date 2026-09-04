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


-- 4. Cache the generated long summary --------------------------------------
-- Called by /api/summarize with the service role, so no anon grant needed.

create or replace function save_story_summary(story_id uuid, body text)
returns void
language sql
security definer
set search_path = public
as $$
  update stories set summary = body where id = story_id;
$$;
