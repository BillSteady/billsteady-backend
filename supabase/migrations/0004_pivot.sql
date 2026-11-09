-- Pivot (2026-11-08): BillSteady went from "naira bill planner, no crypto"
-- to "non-custodial Stellar/stablecoin bill pay" - see billsteady-landing's
-- CLAUDE.md for the full reasoning. This migration drops what the old
-- planning model needed and adapts what's left for the new one.
--
-- Migrations are append-only: 0001/0002/0003 are never edited, only
-- superseded. This is pre-launch with zero real users and no live project,
-- so a clean DROP of the obsolete tables is the right call - preserving
-- their data with a deprecation flag would be protecting nothing real.

-- ---------------------------------------------------------------------
-- Drop what the save-first / reminder model needed
-- ---------------------------------------------------------------------
-- The reminders cron job may not actually exist in whatever environment
-- this runs in (pg_cron/pg_net aren't installable without Docker, so it
-- was never really scheduled in local verification) - guard instead of
-- assuming.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('reminders-every-15-min');
  end if;
exception when others then
  null; -- job never existed in this environment; not fatal
end $$;

drop table if exists public.reminders cascade;
drop table if exists public.extension_requests cascade;
drop table if exists public.plans cascade;

-- auth.users-driven signup doesn't exist in the new flow (see "users
-- auth model" below) - this trigger/function from 0001 has nothing left
-- to fire from.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- users: wallet-address identity instead of phone-OTP
-- ---------------------------------------------------------------------
-- 0001 made `id` a foreign key to auth.users(id) because Supabase Auth's
-- phone-OTP flow owned signup. The new flow authenticates by SEP-10
-- (Stellar Web Auth: the wallet signs a challenge, a self-issued JWT
-- proves it) - see supabase/functions/sep10-auth/README.md - so there's
-- no auth.users row driving this anymore. `id` becomes a free-standing
-- uuid, and the self-issued JWT sets `sub` to this id, so every existing
-- `auth.uid() = user_id`-style RLS policy in this schema keeps working
-- completely unchanged - this is why that JWT shape was chosen over
-- inventing a new claim.
alter table public.users drop constraint if exists users_id_fkey;
alter table public.users alter column id set default gen_random_uuid();

-- Added NOT NULL directly, not via backfill-then-constrain: this table has
-- zero real rows (pre-launch), so there's nothing to backfill.
alter table public.users add column stellar_address text not null;
alter table public.users add constraint users_stellar_address_unique unique (stellar_address);

-- Phone/country were required for the old SMS-first flow; phone is now
-- optional (only relevant if someone opts into SMS payment receipts),
-- and country isn't needed at all - the biller being paid is always
-- Nigerian regardless of where the payer is (the diaspora-sender persona
-- depends on this).
alter table public.users alter column phone drop not null;
alter table public.users alter column country drop not null;

-- ---------------------------------------------------------------------
-- bills -> saved_billers: a convenience list for quick re-pay, not a
-- planning record. The amount/due-date/recurrence columns existed to
-- project a running balance against a payday - nothing in the new flow
-- plans ahead; the amount due is always looked up live from VTpass at
-- payment time, never pre-stored.
-- ---------------------------------------------------------------------
alter table public.bills rename to saved_billers;

alter table public.saved_billers drop constraint if exists bills_once_has_due_date;
alter table public.saved_billers drop column if exists amount_kobo;
alter table public.saved_billers drop column if exists due_day;
alter table public.saved_billers drop column if exists recurrence;
alter table public.saved_billers drop column if exists due_date;
alter table public.saved_billers drop column if exists paid_kobo;

-- Indexes/policies move with the table automatically on RENAME; only the
-- index name is cosmetic leftover, harmless to leave as bills_user_id_idx.

-- ---------------------------------------------------------------------
-- biller_settlements: which on-chain address a biller's payment settles
-- to, per asset. Public reference data (not secret - anyone can see where
-- a biller's funds go), written only by service_role/ops.
--
-- This is deliberately a SEPARATE store from the BillPaymentRouter
-- contract's own on-chain allowlist (billsteady-contracts/router), not
-- derived from it automatically. The contract is the actual source of
-- truth for where a `pay()` call can send funds; this table is what the
-- app displays and what quotes are built against. They can drift if one
-- is updated without the other - there's no sync job here yet. Flagging
-- this explicitly rather than pretending it's already reconciled.
-- ---------------------------------------------------------------------
create table public.biller_settlements (
  id uuid primary key default gen_random_uuid(),
  biller_code text not null,
  asset_code text not null check (asset_code in ('XLM', 'USDC')),
  settlement_address text not null,
  created_at timestamptz not null default now(),
  constraint biller_settlements_code_asset_unique unique (biller_code, asset_code)
);

alter table public.biller_settlements enable row level security;

create policy "biller_settlements public read" on public.biller_settlements
  for select using (true);

-- No write policy for any client role: only service_role (ops) maintains
-- this table.

-- ---------------------------------------------------------------------
-- payment_orders: adapt for an on-chain-first flow
-- ---------------------------------------------------------------------
-- `jar_id` was a placeholder for the old jar-contract model, always
-- nullable and never referenced by a real table (0003's own comment says
-- so). There is no more jar; drop it rather than carry dead weight.
alter table public.payment_orders drop column if exists jar_id;

alter table public.payment_orders rename column bill_id to biller_id;

-- Which wallet is paying, in which asset, and the two pieces of on-chain
-- proof the "never call VTpass before on-chain confirmation" rule depends
-- on: order_ref is generated server-side at quote time and must be passed
-- byte-for-byte as the BillPaymentRouter.pay() `order_ref: BytesN<32>`
-- argument, so this row and the on-chain event can be matched
-- unambiguously; onchain_tx_hash is filled in once that match is
-- confirmed, never before.
-- Again, NOT NULL added directly: zero real rows exist in this table yet.
alter table public.payment_orders add column stellar_address text not null;
alter table public.payment_orders add column asset_code text not null check (asset_code in ('XLM', 'USDC'));
alter table public.payment_orders add column order_ref bytea not null;
alter table public.payment_orders add constraint payment_orders_order_ref_length check (octet_length(order_ref) = 32);
alter table public.payment_orders add constraint payment_orders_order_ref_unique unique (order_ref);
-- Nullable: unset until the on-chain payment is confirmed.
alter table public.payment_orders add column onchain_tx_hash text;

create index payment_orders_stellar_address_idx on public.payment_orders (stellar_address);
-- Supports the indexer's "have I already matched this on-chain tx" check.
create index payment_orders_onchain_tx_hash_idx on public.payment_orders (onchain_tx_hash) where onchain_tx_hash is not null;
