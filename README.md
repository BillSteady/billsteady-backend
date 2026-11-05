# BillSteady Backend

Supabase backend (Postgres, Auth, Edge Functions) for
[BillSteady](https://github.com/bytescape30/billsteady-web): a bill planner
for people short on cash in Nigeria (then Kenya, Ghana).

## Status: Phase 0.4 written, not yet verified against a real Supabase project

What exists and is actually proven:

- `supabase/migrations/0001_core.sql` — the six core tables (`users`,
  `plans`, `bills`, `reminders`, `extension_requests`, `audit_log`), every
  one with RLS. Money is always `bigint` kobo, never float/numeric.
- `supabase/tests/0001_core_rls_test.sql` — a real two-user RLS test
  (create as user A, confirm user B can't read/write it even by id; confirm
  a user can edit their own `notify_channel` but **cannot** self-set
  `kyc_status` to `'verified'` through the Data API; confirm `audit_log` is
  fully inaccessible to ordinary users in both directions; confirm
  `reminders` are user-readable but writable only by `service_role`).
- `supabase/functions/send-otp-sms/` — the Supabase Auth "Send SMS Hook"
  that calls Termii (Termii isn't a built-in Supabase SMS provider). Signed
  per the Standard Webhooks spec, verified before anything in the payload
  is trusted. 4 Deno tests, all passing, including one asserting the Termii
  API key never leaks into an error response.

**What was and wasn't verified, precisely:** Docker is not installed on the
machine this was built on, so `supabase start` (the normal way to run RLS
tests against a real local Postgres) doesn't work here. Instead, the
migration and the RLS test above were run for real against a throwaway
native PostgreSQL 15 cluster with a minimal hand-written stand-in for what
Supabase itself provides (`auth.users`, `auth.uid()`, and the
anon/authenticated/service_role roles with matching grants) — not a mock,
an actual Postgres instance enforcing RLS. That's strong evidence the SQL
and policies are correct, but it is **not** a substitute for running this
against the real `supabase start` stack (or a real hosted project) before
trusting it with real user data — do that before this ships.

Still blocked on external accounts:
- a Supabase project (to actually deploy this)
- a Termii account + API key, and the real `TERMII_BASE_URL` (Termii's docs
  didn't state a literal default — confirm it on the Termii dashboard)
- a `SUPABASE_AUTH_SEND_SMS_HOOK_SECRET` generated once a project exists

See [the roadmap](https://github.com/bytescape30/billsteady-web/blob/main/docs/ROADMAP.md)
for the full build plan.

## Related repos

- [billsteady-web](https://github.com/bytescape30/billsteady-web) — the planner PWA
- [billsteady-contracts](https://github.com/bytescape30/billsteady-contracts) — the Soroban jar smart contract

## License

MIT — see [LICENSE](LICENSE).
