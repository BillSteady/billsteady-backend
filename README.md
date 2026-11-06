# BillSteady Backend

Supabase backend (Postgres, Auth, Edge Functions) for
[BillSteady](https://github.com/BillSteady/billsteady-web): a bill planner
for people short on cash in Nigeria (then Kenya, Ghana).

## Status: Phase 0.4 + Phase 1 (SMS half) + Phase 2.1 written, not yet verified against a real Supabase project

What exists and is actually proven:

- `supabase/migrations/0001_core.sql` — the six core tables (`users`,
  `plans`, `bills`, `reminders`, `extension_requests`, `audit_log`), every
  one with RLS. Money is always `bigint` kobo, never float/numeric.
- `supabase/migrations/0002_reminders.sql` — adds `users.sms_opted_out`,
  `plans.nudge_hour_utc`, and reminder-scheduling columns
  (`kind`, `for_date`, `provider_message_id`, `retry_count`) plus a unique
  `(bill_id, kind, for_date)` index that's the actual dedupe mechanism (an
  `ON CONFLICT ... DO NOTHING` insert, not an application-level check) so
  the same reminder is never sent twice even across overlapping cron ticks.
  Also enables `pg_cron`/`pg_net` and schedules the reminders job every 15
  minutes — **the cron/pg_net wiring itself is the one part of this
  migration that could not be verified locally** (neither extension is
  installable on a plain local Postgres; they're Supabase/managed-Postgres
  features), see below.
- `supabase/tests/0001_core_rls_test.sql` — a real two-user RLS test
  (create as user A, confirm user B can't read/write it even by id; confirm
  a user can edit their own `notify_channel` but **cannot** self-set
  `kyc_status` to `'verified'` through the Data API; confirm `audit_log` is
  fully inaccessible to ordinary users in both directions; confirm
  `reminders` are user-readable but writable only by `service_role`).
- `supabase/functions/_shared/termii.ts` — the Termii "Send Message" API
  client, shared by both functions below (moved here from `send-otp-sms/`
  when `reminders` needed it too).
- `supabase/functions/_shared/date.ts` — a deliberate, minimal port of
  billsteady-web's tested date-math (`nextDayOfMonthOnOrAfter` and friends),
  scoped down to only what due-date logic needs.
- `supabase/functions/send-otp-sms/` — the Supabase Auth "Send SMS Hook"
  that calls Termii. Signed per the Standard Webhooks spec, verified before
  anything in the payload is trusted. 4 Deno tests, all passing.
- `supabase/functions/reminders/` — Prompt 1.1's SMS reminders (3-day and
  1-day due-date warnings, plus a daily set-aside nudge at an hour the user
  picks — `plans.nudge_hour_utc`, UTC-hour granularity since Nigeria has no
  DST). Split into `logic.ts` (pure decision functions: which bills need
  which reminder right now, the daily set-aside amount — 15 tests) and
  `index.ts` (the orchestration: dedupe-insert, send, retry-once-then-fail —
  20 tests total including this file). **A real bug was caught and fixed
  while testing this**: the first version retried a failed send
  *immediately, within the same cron tick*, instead of waiting for the next
  one ~15 minutes later — the retry-pending snapshot now has to be taken
  *before* that tick's own first-attempt sends run, or a freshly-failed
  send gets retried before any real time has passed, defeating the point of
  a retry.
- `supabase/functions/sms-opt-out/` — the inbound-reply handler for "reply
  STOP". Termii's own docs (fetched directly while building this, see
  `logic.ts`'s header comment) don't define a separate inbound-message
  webhook: replies arrive on the same delivery-report webhook with
  `status: "Received"`, and events are signed with `X-Termii-Signature`
  (HMAC-SHA512) — both confirmed facts from Termii's docs, not guesses. What
  is **not** confirmed: the exact signing secret to use (Termii's docs say
  "your secret key" without saying which dashboard value that is), and this
  has never seen a real signed request from Termii. 16 tests, including
  real HMAC-SHA512 computation (not mocked crypto) for the signature checks.
- `supabase/migrations/0003_payment_orders.sql` — the `payment_orders`
  table (Prompt 2.1): `user_id`/`bill_id` foreign keys, a nullable `jar_id`
  with no FK yet (v2/Phase 3 - no `jars` table exists to reference), a real
  UNIQUE constraint on `idempotency_key` (not an application-level check),
  and a `clock_timestamp()`-based trigger that keeps `updated_at` honest
  (deliberately not `now()` - see the migration's comment: `now()` is
  frozen for the whole transaction it runs in, which made the first version
  of this trigger's own test fail even though the trigger was correct in
  normal, one-UPDATE-per-transaction production use). Same trust model as
  `reminders`: a user can read their own orders; only `service_role` (the
  not-yet-built Prompt 2.2 Edge Function) can create or transition one.
- `supabase/functions/_shared/payment-order-state-machine.ts` — the pure
  state machine (`quote → funded → paying → paid|failed`,
  `failed → refunded`), 13 tests, written before the implementation existed
  (confirmed failing on a missing-module error first). Returns a typed
  rejection for an illegal transition rather than throwing - an illegal
  transition is an expected, recoverable outcome (a retried webhook, two
  workers racing the same order), not a bug to crash on. `paid → refunded`
  is deliberately not modeled: the PRD's Prompt 2.1 only names the five
  transitions above, so a post-payment refund path isn't invented here.
- **Deliberately not written**: the real Supabase-backed data-access layer
  for `reminders` and `sms-opt-out` (the part that actually queries/writes
  Postgres via `@supabase/supabase-js`). Both functions are structured with
  an injected `Deps` interface specifically so the decision logic could be
  fully tested without one — writing a concrete Supabase client against an
  *unverified* live schema shape (no project exists to check the PostgREST
  schema cache against) would have been guessing, not building. Both
  `index.ts` files throw loudly if run directly, rather than silently
  pretending to work.

**What was and wasn't verified, precisely:** Docker is not installed on the
machine this was built on, so `supabase start` (the normal way to run RLS
tests against a real local Postgres) doesn't work here. Instead, all three
migrations and both RLS test files (`0001_core_rls_test.sql`,
`0003_payment_orders_test.sql`) were run together, in sequence, for real,
against a throwaway native PostgreSQL 15 cluster with a minimal
hand-written stand-in for what Supabase itself provides (`auth.users`,
`auth.uid()`, and the anon/authenticated/service_role roles with matching
grants) — not a mock, an actual Postgres instance enforcing RLS and the
schema's check constraints and unique indexes (including the reminders
dedupe index, confirmed to actually reject a duplicate
`(bill_id, kind, for_date)` via `ON CONFLICT ... DO NOTHING`, and
`payment_orders.idempotency_key`'s UNIQUE constraint, confirmed to reject a
real duplicate insert with a real `unique_violation`, not just assumed from
the DDL). Running the full migration sequence together (rather than each
migration verified in isolation, as before) caught a real gap:
`0001_core_rls_test.sql`'s own reminders insert predated `0002`'s new
`NOT NULL` columns and started failing the moment all three migrations
applied together - fixed in that test file, which is why this now matters:
**verify the whole stack together going forward, not each migration in
isolation**, or gaps like this won't surface. Building `0003`'s test also
caught a real misunderstanding on this session's part about Postgres RLS:
an `UPDATE` with no applicable policy doesn't raise an exception the way an
`INSERT` does - it silently matches zero rows - so the first version of the
"users can't self-mark an order paid" assertion would have passed even if
that protection had been broken, because it was waiting for an exception
that Postgres was never going to raise. Fixed to check the row's actual
state instead, matching the pattern `0001`'s own cross-user `bills` update
test already used correctly.

The `pg_cron`/`pg_net` extensions and the `cron.schedule(...)` job itself
still could **not** be verified this way — they aren't available as
installable extensions on a plain local Postgres, only on Supabase's
managed platform — so that part of `0002_reminders.sql` is unverified SQL,
written to match Supabase's documented pattern as closely as this session
could confirm without a live project. All of this is strong evidence the
schema and logic are correct, but it is **not** a substitute for running
against the real `supabase start` stack (or a real hosted project) before
trusting it with real user data or a real cron schedule — do that before
this ships.

Still blocked on external accounts:
- a Supabase project (to actually deploy this, and to confirm `pg_cron`/
  `pg_net` behave as written)
- a Termii account + API key, the real `TERMII_BASE_URL`, and the real
  webhook-signing secret for `sms-opt-out` (none of these have a stated
  literal default in Termii's docs — confirm all three on the Termii
  dashboard)
- a `SUPABASE_AUTH_SEND_SMS_HOOK_SECRET` generated once a project exists
- WhatsApp Business Cloud API approval for Prompt 1.2 (WhatsApp reminders)
  — deliberately out of scope for this slice; users with
  `notify_channel = 'whatsapp'` get no reminders yet, by design

See [the roadmap](https://github.com/BillSteady/billsteady-web/blob/main/docs/ROADMAP.md)
for the full build plan.

## Related repos

- [billsteady-web](https://github.com/BillSteady/billsteady-web) — the planner PWA
- [billsteady-contracts](https://github.com/BillSteady/billsteady-contracts) — the Soroban jar smart contract

## License

MIT — see [LICENSE](LICENSE).
