# BillSteady Backend

Supabase backend for BillSteady. No lending, ever. BillSteady never holds
user funds or private keys — the backend plans, reminds and keeps records;
licensed partners custody money.

This repo is one of three:
- [billsteady-web](https://github.com/BillSteady/billsteady-web): the planner PWA
- **billsteady-backend** (this repo): Supabase (Postgres, Auth, Edge Functions)
- [billsteady-contracts](https://github.com/BillSteady/billsteady-contracts): the Soroban jar contract (Rust)

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
Phase 0.4 (0001_core.sql, RLS, send-otp-sms hook) and Phase 1's SMS half
(0002_reminders.sql, reminders + sms-opt-out functions) are written and
logic-tested (40 Deno tests total), verified against a throwaway native
Postgres cluster where possible (no Docker on this machine). pg_cron/pg_net
and the real Supabase-backed DB access layer for reminders/sms-opt-out are
NOT verified - see README.md for exactly what is and isn't proven. Prompt
1.2 (WhatsApp reminders) is deliberately deferred, not forgotten - needs
WhatsApp Business Cloud API approval this project doesn't have.
Blocked on: a Supabase project, a Termii account + API key + webhook secret.
