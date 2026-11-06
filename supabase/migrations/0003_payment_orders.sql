-- Phase 2 (Prompt 2.1): payment_orders - the idempotent state machine for
-- naira bill payments. No VTpass/Paystack wiring yet (that's Prompt 2.2,
-- a separate migration-free Edge Function slice); this is the data model
-- and the state machine only.
--
-- Migrations are append-only: 0001_core.sql and 0002_reminders.sql are
-- never edited, only added to.
--
-- Legal transitions, enforced in application code by
-- supabase/functions/_shared/payment-order-state-machine.ts, NOT by a
-- Postgres trigger: quote -> funded -> paying -> (paid | failed),
-- failed -> refunded. The CHECK constraint below only restricts `status`
-- to a known value, it does not enforce transition legality - that's
-- intentionally the Edge Function's job (it needs to run transition()
-- before issuing the UPDATE, know why a transition was rejected, and log
-- it), not a trigger that would just reject the write with a generic
-- Postgres error.

create table public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  -- v2/Phase 3 (Stellar jars) - no `jars` table exists yet, so this can't
  -- be a foreign key today. Nullable and unreferenced on purpose: Phase 2
  -- payments are naira-only, paid from the planner's own cash tracking,
  -- not from an on-chain jar. Add the FK once the jars table exists
  -- (Phase 3), don't guess its shape now.
  jar_id uuid,
  amount_kobo bigint not null check (amount_kobo > 0),
  -- Which licensed aggregator/payment processor this order runs through
  -- (e.g. 'vtpass', 'paystack'). Not constrained to a fixed list yet since
  -- Prompt 2.2 (not built) is what actually picks and integrates one -
  -- constraining this now would be guessing at a decision that hasn't
  -- been made.
  provider text not null,
  provider_ref text,
  idempotency_key text not null,
  status text not null default 'quote'
    check (status in ('quote', 'funded', 'paying', 'paid', 'failed', 'refunded')),
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_orders_idempotency_key_unique unique (idempotency_key)
);

alter table public.payment_orders enable row level security;

create index payment_orders_user_id_idx on public.payment_orders (user_id);
create index payment_orders_bill_id_idx on public.payment_orders (bill_id);
-- Supports the reconciliation job (tracked separately, Prompt 2.3): "any
-- order stuck in `paying` for over 10 minutes" needs to find rows by
-- (status, updated_at) cheaply.
create index payment_orders_status_updated_at_idx on public.payment_orders (status, updated_at);

-- Keep updated_at honest on every UPDATE - the reconciliation job's "stuck
-- over 10 minutes" check is meaningless if this can go stale. Deliberately
-- clock_timestamp(), not now(): now()/transaction_timestamp() is frozen
-- for the entire transaction it's called in, so two updates inside the
-- same transaction would get an identical updated_at - clock_timestamp()
-- reflects real wall-clock time at the moment the trigger actually runs,
-- which is what "staleness since last touched" needs.
create function public.payment_orders_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger payment_orders_updated_at
  before update on public.payment_orders
  for each row execute function public.payment_orders_set_updated_at();

-- Same trust model as `reminders`: a user may READ their own payment
-- orders (so the app can show order status/receipts), but creation and
-- every status transition happens only through the (not yet built,
-- Prompt 2.2) Edge Function running as service_role, which bypasses RLS.
-- No insert/update/delete policy for ordinary users - letting a client
-- write its own idempotency_key or flip its own status straight to 'paid'
-- would defeat the entire point of an idempotent, provider-verified state
-- machine.
create policy "payment_orders select own" on public.payment_orders
  for select using (auth.uid() = user_id);
