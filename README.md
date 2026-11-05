# BillSteady Backend

Supabase backend (Postgres, Auth, Edge Functions) for
[BillSteady](https://github.com/bytescape30/billsteady-web): a bill planner
for people short on cash in Nigeria (then Kenya, Ghana).

## Status: not started

This repo is a placeholder. Nothing here runs yet. Phase 0.4 (DB schema +
RLS + phone OTP login) is blocked on provisioning real accounts:

- a Supabase project
- a Termii account + API key (SMS OTP)

See [the PRD](https://github.com/bytescape30/billsteady-web/blob/main/docs/ROADMAP.md)
for the full build plan. When this repo has real code, it will contain:

- `supabase/migrations/` — Postgres schema, append-only, every table with RLS
- `supabase/functions/` — Edge Functions (reminders cron, payment orders,
  anchor/VTpass integration), each checking the authenticated user

## Related repos

- [billsteady-web](https://github.com/bytescape30/billsteady-web) — the planner PWA
- [billsteady-contracts](https://github.com/bytescape30/billsteady-contracts) — the Soroban jar smart contract

## License

MIT — see [LICENSE](LICENSE).
