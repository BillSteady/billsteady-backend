# BillSteady Backend

Supabase backend for BillSteady: non-custodial Stellar/stablecoin bill pay.
BillSteady never holds user funds or private keys — every on-chain payment
is signed by the user's own wallet and moves straight to a billing
settlement address in one atomic transaction; this backend verifies bills,
confirms on-chain payments, and settles with the biller through VTpass.

## Pivot (2026-11-08)

Went from "naira bill planner, no crypto, phone-OTP login" to this. See
billsteady-landing's CLAUDE.md for the full product reasoning. For this
repo specifically: the `plans`/`reminders`/`extension_requests` tables and
the Termii phone-OTP login flow are gone (`0004_pivot.sql`) — nothing left
to plan or remind about when a user already holds the funds. Login is now
SEP-10 Stellar Web Auth (the user's wallet signs a challenge) bridged into
a self-issued, Supabase-compatible session JWT — see
`supabase/functions/_shared/supabase-jwt.ts`'s header comment for exactly
why, and `supabase/functions/sep10-auth/README.md` for the flow.

This repo is one of four:
- [billsteady-web](https://github.com/BillSteady/billsteady-web): the wallet-connect + pay-bill UI
- **billsteady-backend** (this repo): Supabase (Postgres, Auth, Edge Functions)
- [billsteady-contracts](https://github.com/BillSteady/billsteady-contracts): the BillPaymentRouter Soroban contract
- [billsteady-landing](https://github.com/BillSteady/billsteady-landing): the public landing page

## Stack
- Supabase: Postgres, Edge Functions (TypeScript) — GoTrue/Supabase Auth is
  deliberately NOT used for login, see above
- SEP-10 Stellar Web Auth via `@stellar/stellar-sdk`'s `WebAuth` helpers
- VTpass for bill verification + payment (sandbox account not yet provisioned)

## Commands
- supabase start | supabase db reset | supabase functions serve
(not yet runnable — no Supabase project provisioned)
- deno test --allow-net --allow-env supabase/functions/
- find supabase/functions -name "*.ts" | xargs deno check

## Rules
- Money is integer minor units: kobo for NGN. Never floats.
- No secrets in code, logs, or committed files. Never read .env; use .env.example.
- Every table has RLS. Every Edge Function checks the user.
- Payment orders are idempotent; status moves only forward through the state machine.
- **Never call VTpass before the matching on-chain payment is confirmed and
  recorded (`status = 'funded'`).** This is the one rule that makes the
  whole pivot honestly non-custodial — see
  `supabase/functions/_shared/payment-orchestration.ts`.
- Migrations are append-only.

## Workflow
- Plan first, write a failing test, implement, run checks, show output, commit.

## Current phase
`0004_pivot.sql` + SEP-10 auth + VTpass bill verification + the contract
event indexer/orchestration are written and tested (43 Deno tests), schema
+ RLS verified against a throwaway native Postgres cluster (no Docker on
this machine) — all four migrations and three RLS test files run together.
See README.md for exactly what is and isn't proven, and what's still
provisional (the on-chain event shape, until billsteady-contracts/router's
README confirms it).

Blocked on external accounts: a Supabase project, a VTpass sandbox account.
No Termii account needed anymore for login (SEP-10 replaced it); optional
SMS payment receipts are a possible future use for Termii, not built.
