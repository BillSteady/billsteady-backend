-- Minimal stand-in for what Supabase itself provides (an `auth` schema, an
-- `auth.uid()` function reading the JWT's `sub` claim via the same
-- `request.jwt.claim.sub` GUC PostgREST sets, and the anon/authenticated/
-- service_role roles with matching default grants), so migrations and RLS
-- can be verified for real against a throwaway native Postgres cluster
-- without Docker (not installed on the machines this repo has been built
-- on so far).
--
-- Previously this lived only in /tmp and got hand-reconstructed from
-- scratch each verification session - committing it this time so it
-- doesn't have to be re-derived again. NOT a substitute for `supabase
-- start` against the real stack - see README.md's verification notes.
--
-- Usage:
--   createdb billsteady_test
--   psql billsteady_test -f supabase/tests/_stub_auth_schema.sql
--   psql billsteady_test -f supabase/migrations/0001_core.sql
--   psql billsteady_test -f supabase/migrations/0002_reminders.sql
--   psql billsteady_test -f supabase/migrations/0003_payment_orders.sql
--   psql billsteady_test -f supabase/migrations/0004_pivot.sql
--   psql billsteady_test -f supabase/tests/0001_core_rls_test.sql
--   psql billsteady_test -f supabase/tests/0003_payment_orders_test.sql
--   psql billsteady_test -f supabase/tests/0004_pivot_test.sql

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Real Supabase grants anon/authenticated broad table-level privileges by
-- default (RLS policies are what actually restrict access at the row
-- level - without this grant, the role can't even attempt the operation,
-- which masked a real gap here: every migration below runs AFTER this
-- file, so these need to be DEFAULT privileges, not just applied to
-- tables that already exist yet (none do yet, at this point in the
-- sequence).
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
