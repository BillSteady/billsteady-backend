# BillSteady Backend

Supabase backend (Postgres, Edge Functions) for
[BillSteady](https://github.com/BillSteady/billsteady-web): pay real
Nigerian bills — electricity, airtime, data, school fees — directly from a
Stellar wallet, in XLM or USDC, non-custodially.

## Status: pivoted and rebuilt (2026-11-08), not yet verified against a real Supabase project

BillSteady pivoted from a naira-only, no-crypto bill planner to this. See
[CLAUDE.md](CLAUDE.md) and
[billsteady-landing's CLAUDE.md](https://github.com/BillSteady/billsteady-landing/blob/main/CLAUDE.md)
for the full reasoning. This README describes the backend as it exists
after that pivot; the prior naira-planner version is still in git history
(commits up to `027c04a`) if useful context, but nothing below assumes it.

### What exists and is actually proven

- **`supabase/migrations/0004_pivot.sql`** — drops `plans`, `reminders`,
  `extension_requests`, and the `auth.users`-driven signup trigger (nothing
  left to plan/remind about, and login no longer goes through Supabase
  Auth — see below). Renames `bills` to `saved_billers` and strips its
  planning columns (amount/due-date/recurrence/paid-so-far — the amount due
  is always looked up live from VTpass now, never pre-stored). Makes
  `users.id` a free-standing uuid (no longer FK'd to `auth.users`) with a
  new `stellar_address` identity column. Adds `biller_settlements`
  (public-read, service-role-write: which on-chain address a biller's
  payment settles to, per asset) and extends `payment_orders` with
  `stellar_address`, `asset_code`, `order_ref` (32 bytes, UNIQUE, must match
  the on-chain `BillPaymentRouter.pay()` call byte-for-byte), and
  `onchain_tx_hash`.
- **Why login isn't Supabase Auth anymore**: Supabase Auth has no Stellar
  provider (checked `supabase/config.toml`'s `[auth.web3.*]` blocks —
  Solana and Ethereum exist, Stellar doesn't). `supabase/functions/sep10-auth/`
  implements SEP-10 (Stellar Web Auth) using `@stellar/stellar-sdk`'s own
  `WebAuth.buildChallengeTx`/`readChallengeTx`/`verifyChallengeTxSigners` —
  not hand-rolled, SEP-10 is a precise spec and getting it subtly wrong is a
  security bug, not a style choice. A verified challenge mints a
  self-issued, Supabase-compatible session JWT
  (`supabase/functions/_shared/supabase-jwt.ts`) with `sub` set to the
  user's `public.users.id`, which is why `auth.uid()` (and therefore every
  existing `auth.uid() = user_id` RLS policy) keeps working unchanged even
  though GoTrue never issued the token — see that file's header comment for
  the full reasoning and what's and isn't confirmed about Supabase
  accepting a token it didn't issue (a documented pattern, not yet
  confirmed against a live project).
- **Real finding while testing SEP-10**: `@stellar/stellar-sdk` 13.3.0's
  `readChallengeTx` grants a **5-minute grace period** past a challenge's
  own expiry before treating it as expired (confirmed by reading the
  compiled source, not assumed from the spec text — see
  `stellar-webauth.test.ts`'s comment on the expiry test, which originally
  waited 1.3s past a 1s timeout and wrongly expected rejection). Worth
  knowing if `sep10-auth`'s challenge timeout is ever tuned down for UX.
- **`supabase/functions/_shared/vtpass.ts`** — bill verification client
  (meter/smartcard number → customer name + amount due, where VTpass
  returns one). Endpoint shape follows VTpass's publicly documented API;
  like `TERMII_BASE_URL` before it, this has **not** been confirmed against
  a real VTpass account (none exists yet — billsteady-backend issue #4).
- **`supabase/functions/_shared/payment-event-indexer.ts`** — parses a
  `BillPaymentRouter.pay()` success event from Stellar RPC's `getEvents`
  shape. **Provisional**: billsteady-contracts' `router/` contract was
  being built in a parallel session and its README (the real source of
  truth for the event shape) didn't exist yet when this was written. Built
  against the shape specified in the coordinating session's own directive
  to that session (topic `("bill_paid",)`, data `(payer, biller_id,
  order_ref, amount)`), isolated in one small function specifically so it's
  a one-file fix once that README exists — diff and fix on sight if it
  differs.
- **`supabase/functions/_shared/payment-orchestration.ts`** — the rule that
  makes this honestly non-custodial: VTpass is never called until the
  matching on-chain payment is confirmed and `payment_orders.status` is
  durably `funded`. Tested explicitly, not just by convention — one test
  asserts the actual call order (`markOrderFunded` before `payViaVtpass`,
  every time), another confirms a duplicate/redelivered on-chain event
  (order already `funded`) never triggers a second VTpass payment.
- **`supabase/functions/sep10-auth/`** — the login HTTP handler (GET issues
  a challenge, POST verifies it and issues a session). 6 tests covering the
  full round trip plus the unsigned-challenge rejection path.
- **`payment-order-state-machine.ts`** — unchanged from the pre-pivot
  version (`quote → funded → paying → paid|failed`, `failed → refunded`);
  only what each state *means* changed (`funded` now specifically means
  "on-chain payment confirmed," not "naira cash available").

### What was and wasn't verified, precisely

Docker is still not installed on this machine, so `supabase start` doesn't
work here. All four migrations and all three RLS test files
(`0001_core_rls_test.sql`, `0003_payment_orders_test.sql`,
`0004_pivot_test.sql`) were run together, in sequence, for real, against a
throwaway native PostgreSQL 15 cluster with a stand-in `auth` schema/roles —
**this time committed to the repo**
(`supabase/tests/_stub_auth_schema.sql`) instead of living only in `/tmp`
like in prior sessions, so it doesn't have to be reconstructed from scratch
again. Doing that reconstruction surfaced a real gap: the first version was
missing the table-level grants real Supabase gives `anon`/`authenticated`
by default (RLS filters *rows*, but the role still needs a base GRANT to
attempt the operation at all) — every RLS test failed with "permission
denied" until `alter default privileges ... grant select, insert, update,
delete on tables to anon, authenticated` was added.

0001/0003's RLS test files were rewritten to match the post-pivot schema
(bills→saved_billers, bill_id→biller_id, the dropped tables' sections
removed) rather than left to assert against tables that no longer exist —
updating a *test* to match a schema change is normal; only *migrations* are
append-only. `0001_core_rls_test.sql` now covers only `users` and
`audit_log` (what's still true from 0001); `saved_billers`/
`biller_settlements`/`payment_orders` ownership and constraints are covered
in `0003_payment_orders_test.sql` and the new `0004_pivot_test.sql`.

`0002_reminders.sql`'s `pg_cron`/`pg_net` statements still fail on a plain
local Postgres (those extensions aren't installable without Docker) — moot
now, since `0004_pivot.sql` drops the `reminders` table those statements
were scheduling against anyway.

**Not verified, stated plainly:**
- Nothing against a real `supabase start` or hosted project.
- Whether Supabase's real PostgREST deployment accepts the self-issued
  session JWT (a documented pattern, not yet confirmed live).
- VTpass's actual API shape (no sandbox account).
- The contract event shape (provisional, see above).
- Any real on-chain payment flowing through this backend end to end.

### Closed/updated issues from the pre-pivot backlog

- **#2** (confirm Termii opt-out webhook) — closed, moot: Termii/SMS-OTP is
  no longer the login path, and `sms-opt-out` was removed.
- **#3** (payment_orders state machine) — was already closed pre-pivot;
  superseded in spirit by this work, which extends rather than replaces it.
- **#4** (VTpass integration) — left open, still accurate: still blocked on
  a real VTpass sandbox account, now with a real client (`vtpass.ts`)
  waiting for one.
- **#5** (reconciliation job) — left open: still relevant, `payment_orders`
  still needs a "stuck in `paying` too long" sweep.
- **#6** (WhatsApp reminders) — closed: there's nothing left to remind
  about in the new flow.

## Related repos

- [billsteady-web](https://github.com/BillSteady/billsteady-web) — the wallet-connect + pay-bill UI
- [billsteady-contracts](https://github.com/BillSteady/billsteady-contracts) — the BillPaymentRouter Soroban contract
- [billsteady-landing](https://github.com/BillSteady/billsteady-landing) — the public landing page

## License

MIT — see [LICENSE](LICENSE).
