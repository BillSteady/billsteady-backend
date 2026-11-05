-- Phase 1 (Prompt 1.1): scheduling/dedupe columns for reminders, SMS
-- opt-out, a daily nudge time per user, and the pg_cron job that invokes
-- the reminders Edge Function every 15 minutes.
--
-- Migrations are append-only: 0001_core.sql is never edited, only added to.
--
-- NOT YET VERIFIED against a real Supabase project or `supabase start`
-- (same Docker constraint as 0001 - see README.md). The pg_cron/pg_net
-- extension names, schema placement, and the vault-secret wiring below
-- follow Supabase's documented pattern as closely as this session could
-- confirm without a live project; re-check against the actual deployed
-- project before trusting the cron job fires correctly.

-- ---------------------------------------------------------------------
-- users: SMS opt-out ("reply STOP")
-- ---------------------------------------------------------------------
alter table public.users
  add column sms_opted_out boolean not null default false;

-- ---------------------------------------------------------------------
-- plans: per-user daily nudge time
-- ---------------------------------------------------------------------
-- The PRD asks for the nudge at "a time the user picks". There's no
-- settings UI for this yet (frontend work, not this slice), so it's
-- modeled as an hour-of-day in UTC with a reasonable default. Nigeria
-- (the only launch country live in the schema today) is UTC+1 year-round
-- with no DST, so 7 UTC = 8am WAT, a reasonable "after breakfast, before
-- work" default. The cron tick checks this at hour granularity (every
-- 15-minute tick within the matching UTC hour), not to the exact minute -
-- that's an accepted trade-off for Phase 1, not an oversight.
alter table public.plans
  add column nudge_hour_utc smallint not null default 7 check (nudge_hour_utc between 0 and 23);

-- ---------------------------------------------------------------------
-- reminders: dedupe key + provider tracking + bounded retry
-- ---------------------------------------------------------------------
-- `kind` distinguishes the three reminder types the PRD asks for. `for_date`
-- is the calendar date the reminder is *about* - a bill's upcoming due date
-- for the two due-date warnings, or "today" for the daily nudge. Together
-- with bill_id and kind, it's the dedupe key: the same reminder is never
-- scheduled twice even if a cron tick overlaps the previous one, because
-- the Edge Function inserts via `on conflict (bill_id, kind, for_date) do
-- nothing` and only sends when its own insert actually landed a new row.
--
-- The table is empty in every environment this migration will ever run
-- against (nothing is deployed yet), so these are added NOT NULL without a
-- backfill default - if that stops being true before this ships, this
-- migration needs revisiting, not editing (append a new one instead).
alter table public.reminders
  add column kind text not null check (kind in ('due_3d', 'due_1d', 'daily_nudge')),
  add column for_date date not null,
  add column provider_message_id text,
  add column retry_count int not null default 0 check (retry_count >= 0 and retry_count <= 1);

create unique index reminders_dedupe_idx on public.reminders (bill_id, kind, for_date);

-- ---------------------------------------------------------------------
-- pg_cron + pg_net: invoke the reminders Edge Function every 15 minutes
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The reminders function's URL and the service-role key it's called with
-- are environment-specific and secret respectively, so neither is
-- hardcoded here. Both must be set once, after this migration runs,
-- against the real project - documented in README.md:
--
--   alter database postgres
--     set app.settings.reminders_function_url =
--       'https://<project-ref>.supabase.co/functions/v1/reminders';
--
--   select vault.create_secret('<service-role-key>', 'reminders_service_role_key');
--
-- Until both are set, this job will fire every 15 minutes and fail (no url
-- / no secret) rather than silently do nothing - check `cron.job_run_details`
-- after deploy to confirm it's actually succeeding, not just scheduled.
select cron.schedule(
  'reminders-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.reminders_function_url', true),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'reminders_service_role_key'
      )
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
