-- ─────────────────────────────────────────────────────────────
-- 001_auth_migration.sql
-- Run this in your Supabase project → SQL Editor
-- ─────────────────────────────────────────────────────────────

-- 1. Add user_id column (nullable first so existing rows don't break)
alter table vocabs add column if not exists user_id uuid references auth.users(id);

-- 2. Add columns used in JS but missing from original schema
alter table vocabs add column if not exists last_modified bigint default 0;
alter table vocabs add column if not exists deleted boolean default false;

-- 3. Replace the open-access RLS policy with per-user access
drop policy if exists "open" on vocabs;

create policy "own rows" on vocabs
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4. Make user_id required for all future inserts
--    (existing rows without user_id will remain but be invisible under RLS)
alter table vocabs alter column user_id set not null;

-- 5. Two users can both study the same word — unique per (user, word)
alter table vocabs drop constraint if exists vocabs_word_key;
alter table vocabs add constraint vocabs_user_word unique (user_id, word);

-- ─────────────────────────────────────────────────────────────
-- 6. Rate-limit tracking table (only the Edge Function can write here —
--    no RLS policy means the browser's anon key has no access)
-- ─────────────────────────────────────────────────────────────
create table if not exists ai_usage (
  user_id uuid references auth.users(id),
  date    date,
  count   int default 0,
  primary key (user_id, date)
);

alter table ai_usage enable row level security;
-- No policies = browser cannot read or write this table.
-- The Edge Function uses the service-role key which bypasses RLS.
