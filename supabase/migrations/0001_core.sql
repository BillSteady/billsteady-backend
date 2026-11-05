-- Phase 0.4: core tables for the naira planner (users, plans, bills,
-- reminders, extension_requests, audit_log). No Stellar/wallet/jar tables
-- yet - those are Phase 2/3, scoped to a later migration.
--
-- Money is always an integer minor unit (kobo for NGN) stored as bigint.
-- Never numeric/float for money.
--
-- Migrations are append-only: once merged, a migration is never edited,
-- only superseded by a later one.

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
-- One row per app user, 1:1 with an auth.users row (id is shared, not a
-- separate foreign-keyed column) so RLS can key off auth.uid() directly.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  phone text not null unique,
  country text not null check (country in ('NG', 'KE', 'GH')),
  locale text not null default 'en',
  kyc_status text not null default 'none' check (kyc_status in ('none', 'pending', 'verified', 'rejected')),
  notify_channel text not null default 'sms' check (notify_channel in ('sms', 'whatsapp')),
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;

-- A user can read and update only their own row. No insert policy: the row
-- is created by a trigger off auth.users (see below), never directly by a
-- client. No delete policy: account deletion is a backend operation, not
-- exposed to the Data API.
create policy "users select own" on public.users
  for select using (auth.uid() = id);

create policy "users update own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- The policy above controls which ROW a user can update, not which
-- COLUMNS - by default every column is writable through it, which would
-- let a user set their own kyc_status to 'verified' (or change phone/
-- country) through the Data API. Narrow the grant to only the columns a
-- user should self-serve; kyc_status/phone/country change only through
-- service_role-driven backend flows (KYC callback, re-verified phone
-- change, etc), never directly.
revoke update on public.users from authenticated;
grant update (locale, notify_channel) on public.users to authenticated;

-- Create the public.users row automatically when someone signs up via
-- Supabase Auth (phone OTP). Keeps "id" always in sync with auth.users.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, phone, country)
  values (new.id, coalesce(new.phone, ''), 'NG');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- plans
-- ---------------------------------------------------------------------
-- One active plan per user (cash on hand + income + payday rule). Modeled
-- as a single row per user rather than a history table for now; revisit if
-- we need to look back at past plans.
create table public.plans (
  user_id uuid primary key references public.users (id) on delete cascade,
  cash_on_hand_kobo bigint not null default 0 check (cash_on_hand_kobo >= 0),
  income_amount_kobo bigint not null default 0 check (income_amount_kobo >= 0),
  payday_rule jsonb not null default '{"type": "monthly", "dayOfMonth": 28}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;

create policy "plans all own" on public.plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- bills
-- ---------------------------------------------------------------------
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  category text not null default 'other',
  biller_code text,
  customer_ref text,
  amount_kobo bigint not null check (amount_kobo > 0),
  due_day int not null check (due_day between 1 and 31),
  recurrence text not null default 'monthly' check (recurrence in ('monthly', 'once')),
  due_date date,
  paid_kobo bigint not null default 0 check (paid_kobo >= 0),
  created_at timestamptz not null default now(),
  constraint bills_once_has_due_date check (recurrence <> 'once' or due_date is not null)
);

alter table public.bills enable row level security;

create index bills_user_id_idx on public.bills (user_id);

create policy "bills all own" on public.bills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- reminders
-- ---------------------------------------------------------------------
-- No direct user_id column: ownership is scoped through the owning bill, so
-- it can't drift from bills.user_id. The policy joins through bills.
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  send_at timestamptz not null,
  channel text not null check (channel in ('sms', 'whatsapp')),
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'failed', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.reminders enable row level security;

create index reminders_bill_id_idx on public.reminders (bill_id);
create index reminders_send_at_idx on public.reminders (send_at) where status = 'scheduled';

create policy "reminders select own" on public.reminders
  for select using (
    exists (select 1 from public.bills b where b.id = reminders.bill_id and b.user_id = auth.uid())
  );

-- No insert/update/delete policy for reminders: they're created and
-- transitioned only by the reminders Edge Function (Phase 1, pg_cron),
-- which runs with the service_role key and bypasses RLS. Clients only read.

-- ---------------------------------------------------------------------
-- extension_requests (carried over from the v1 prototype)
-- ---------------------------------------------------------------------
create table public.extension_requests (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  message_text text not null,
  created_at timestamptz not null default now()
);

alter table public.extension_requests enable row level security;

create index extension_requests_bill_id_idx on public.extension_requests (bill_id);

create policy "extension_requests all own" on public.extension_requests
  for all using (
    exists (select 1 from public.bills b where b.id = extension_requests.bill_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.bills b where b.id = extension_requests.bill_id and b.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------
-- Append-only, and deliberately not readable through the Data API by
-- anyone, including the acting user: it's a backend/ops tool (who did what,
-- for incident review), not a user-facing activity feed. If a "my activity"
-- feature is ever wanted, it should read from its own purpose-built table,
-- not this one. RLS is enabled with no policies at all, which denies every
-- client-side select/insert/update/delete; only service_role (which
-- bypasses RLS) can write to it from trusted Edge Functions.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.users (id) on delete set null,
  action text not null,
  entity text not null,
  before jsonb,
  after jsonb,
  ts timestamptz not null default now()
);

alter table public.audit_log enable row level security;

create index audit_log_entity_idx on public.audit_log (entity);
create index audit_log_actor_idx on public.audit_log (actor);
