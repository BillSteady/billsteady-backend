# BillSteady Backend

Supabase backend for BillSteady. No lending, ever. BillSteady never holds
user funds or private keys — the backend plans, reminds and keeps records;
licensed partners custody money.

This repo is one of three:
- [billsteady-web](https://github.com/bytescape30/billsteady-web): the planner PWA
- **billsteady-backend** (this repo): Supabase (Postgres, Auth, Edge Functions)
- [billsteady-contracts](https://github.com/bytescape30/billsteady-contracts): the Soroban jar contract (Rust)

## Stack
- Supabase: Postgres, Auth, Edge Functions (TypeScript), pg_cron
- Phone number + OTP login (Termii SMS)

## Commands
- supabase start | supabase db reset | supabase functions serve
(not yet runnable — no Supabase project provisioned)

## Rules
- Money is integer minor units: kobo for NGN. Never floats.
- No secrets in code, logs, or committed files. Never read .env; use .env.example.
- Every table has RLS. Every Edge Function checks the user.
- Payment orders are idempotent; status moves only forward through the state machine.
- Migrations are append-only.

## Workflow
- Plan first, write a failing test, implement, run checks, show output, commit.

## Current phase
Not started. Blocked on: a Supabase project, a Termii account + API key.
