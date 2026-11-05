// Cron-invoked reminders job (Prompt 1.1): fetch bills that might need a
// reminder, decide via logic.ts which ones actually do, insert each
// decided reminder with ON CONFLICT DO NOTHING against the
// (bill_id, kind, for_date) unique index (migration 0002) so a duplicate
// cron tick is a no-op, then send through Termii and record the outcome.
//
// This runs as a trusted scheduled job (service_role), not on behalf of
// any one logged-in user - see supabase/config.toml / the pg_cron job in
// 0002_reminders.sql for how it's invoked and authenticated. It is NOT
// meant to be reachable by an ordinary client; `verify_jwt` stays enabled
// (the default) so a caller needs a valid service-role JWT to reach it at
// all - an anon/authenticated JWT is rejected before this code ever runs.
import { createTermiiClient, type TermiiClient } from "../_shared/termii.ts";
import { planRemindersForBill, type BillCandidate, type PlannedReminder } from "./logic.ts";

export interface InsertResult {
  inserted: boolean;
  reminderId: string;
}

export interface Deps {
  /** Bills that might need a reminder right now (today or near a due date). Already excludes fully-closed bills. */
  listCandidateBills(): Promise<BillCandidate[]>;
  /** Inserts the reminder row via ON CONFLICT (bill_id, kind, for_date) DO NOTHING; inserted=false means it already existed. */
  insertReminderIfNew(r: PlannedReminder): Promise<InsertResult>;
  markSent(reminderId: string, providerMessageId: string): Promise<void>;
  /** Bumps retry_count (0 -> 1) and leaves status as-is for a future tick to retry. */
  markRetryPending(reminderId: string): Promise<void>;
  markFailed(reminderId: string): Promise<void>;
  /** Reminders already at retry_count = 1 that are still 'scheduled' - due for their one retry, this tick. */
  listPendingRetries(): Promise<Array<{ reminderId: string; billId: string; phone: string; message: string }>>;
  termii: TermiiClient;
}

export interface RunSummary {
  planned: number;
  deduped: number;
  sent: number;
  retried: number;
  failed: number;
}

export async function runReminders(today: string, nowUtcHour: number, deps: Deps): Promise<RunSummary> {
  const summary: RunSummary = { planned: 0, deduped: 0, sent: 0, retried: 0, failed: 0 };

  // Snapshot retries left pending by a PREVIOUS tick before this tick's own
  // first-attempt sends run - otherwise a reminder that fails its first
  // attempt here would be retried immediately, in the same invocation,
  // instead of on the next cron tick ~15 minutes later. The 15-minute
  // cadence is the intended backoff between the first attempt and the one
  // retry, not an incidental side effect.
  const pendingFromEarlierTicks = await deps.listPendingRetries();

  const bills = await deps.listCandidateBills();
  const planned = bills.flatMap((b) => planRemindersForBill(b, today, nowUtcHour));
  summary.planned = planned.length;

  for (const reminder of planned) {
    const { inserted, reminderId } = await deps.insertReminderIfNew(reminder);
    if (!inserted) {
      summary.deduped++;
      continue;
    }
    await sendAndRecord(reminderId, reminder.phone, reminder.message, deps, summary, /* isRetry */ false);
  }

  for (const pending of pendingFromEarlierTicks) {
    await sendAndRecord(pending.reminderId, pending.phone, pending.message, deps, summary, /* isRetry */ true);
  }

  return summary;
}

async function sendAndRecord(
  reminderId: string,
  phone: string,
  message: string,
  deps: Deps,
  summary: RunSummary,
  isRetry: boolean,
): Promise<void> {
  const result = await deps.termii.send(phone, message);

  if (result.ok) {
    await deps.markSent(reminderId, result.messageId);
    summary.sent++;
    if (isRetry) summary.retried++;
    return;
  }

  // Never log the message/phone-bearing request details here beyond what
  // the shared Termii client itself already logs (it already withholds the
  // api key - see _shared/termii.ts).
  console.error("reminders: Termii send failed", { reminderId, error: result.error, isRetry });

  if (isRetry) {
    // This WAS the one retry, and it also failed - stop here.
    await deps.markFailed(reminderId);
    summary.failed++;
  } else {
    await deps.markRetryPending(reminderId);
  }
}

export interface Env {
  termiiApiKey: string;
  termiiSenderId: string;
  termiiBaseUrl: string;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function defaultEnv(): Env {
  return {
    termiiApiKey: requireEnv("TERMII_API_KEY"),
    termiiSenderId: requireEnv("TERMII_SENDER_ID"),
    termiiBaseUrl: requireEnv("TERMII_BASE_URL"),
  };
}

// The real Supabase-backed Deps implementation is intentionally NOT written
// here yet: it needs a live project (to confirm the supabase-js nested
// `.select('*, users(*), plans(*))` query shape actually matches the
// deployed PostgREST schema cache) that doesn't exist. Wiring a real
// `supabaseDeps()` against an unverified schema shape and calling it done
// would be worse than leaving this TODO explicit - see README.md.
if (import.meta.main) {
  throw new Error(
    "reminders: no live Deps implementation wired up yet - this needs a real Supabase project to build and verify against (see README.md). " +
      "The decision logic (logic.ts) and the orchestration (runReminders) are fully tested; the Supabase client wiring is not written.",
  );
}

export { createTermiiClient, defaultEnv };
