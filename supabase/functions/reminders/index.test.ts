import { assertEquals } from "jsr:@std/assert@1";
import { runReminders, type Deps, type InsertResult } from "./index.ts";
import type { PlannedReminder } from "./logic.ts";
import type { BillCandidate } from "./logic.ts";
import type { TermiiClient, TermiiSendResult } from "../_shared/termii.ts";

interface StoredReminder {
  id: string;
  billId: string;
  kind: string;
  forDate: string;
  phone: string;
  message: string;
  status: "scheduled" | "sent" | "failed";
  retryCount: number;
  providerMessageId: string | null;
}

/** An in-memory stand-in for the reminders table + its unique (bill_id, kind, for_date) index. */
function fakeStore() {
  const rows: StoredReminder[] = [];
  let nextId = 1;

  const deps: Omit<Deps, "termii" | "listCandidateBills"> = {
    async insertReminderIfNew(r: PlannedReminder): Promise<InsertResult> {
      const existing = rows.find((row) => row.billId === r.billId && row.kind === r.kind && row.forDate === r.forDate);
      if (existing) return { inserted: false, reminderId: existing.id };
      const id = `reminder-${nextId++}`;
      rows.push({
        id,
        billId: r.billId,
        kind: r.kind,
        forDate: r.forDate,
        phone: r.phone,
        message: r.message,
        status: "scheduled",
        retryCount: 0,
        providerMessageId: null,
      });
      return { inserted: true, reminderId: id };
    },
    async markSent(reminderId, providerMessageId) {
      const row = rows.find((r) => r.id === reminderId)!;
      row.status = "sent";
      row.providerMessageId = providerMessageId;
    },
    async markRetryPending(reminderId) {
      const row = rows.find((r) => r.id === reminderId)!;
      row.retryCount = 1;
    },
    async markFailed(reminderId) {
      const row = rows.find((r) => r.id === reminderId)!;
      row.status = "failed";
    },
    async listPendingRetries() {
      return rows
        .filter((r) => r.status === "scheduled" && r.retryCount === 1)
        .map((r) => ({ reminderId: r.id, billId: r.billId, phone: r.phone, message: r.message }));
    },
  };

  return { rows, deps };
}

function fakeTermii(behavior: (to: string, message: string) => TermiiSendResult): {
  client: TermiiClient;
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    client: {
      async send(to, message) {
        calls.push([to, message]);
        return behavior(to, message);
      },
    },
  };
}

function bill(overrides: Partial<BillCandidate> = {}): BillCandidate {
  return {
    billId: "bill-1",
    userId: "user-1",
    phone: "+2348012345678",
    notifyChannel: "sms",
    smsOptedOut: false,
    name: "Electricity",
    amountKobo: 10_000_00,
    dueDay: 10,
    recurrence: "monthly",
    dueDate: null,
    paidKobo: 0,
    nudgeHourUtc: 99, // out of range on purpose: these orchestration tests aren't about the nudge
    ...overrides,
  };
}

Deno.test("a reminder that sends successfully is marked sent with Termii's message id", async () => {
  const { rows, deps } = fakeStore();
  const { client, calls } = fakeTermii(() => ({ ok: true, messageId: "termii-msg-1" }));

  const summary = await runReminders("2026-11-09", 12, {
    ...deps,
    termii: client,
    listCandidateBills: async () => [bill({ dueDay: 10 })], // 1 day out from 2026-11-09
  });

  assertEquals(summary, { planned: 1, deduped: 0, sent: 1, retried: 0, failed: 0 });
  assertEquals(calls.length, 1);
  assertEquals(rows[0].status, "sent");
  assertEquals(rows[0].providerMessageId, "termii-msg-1");
});

Deno.test("running twice for the same bill/kind/date dedupes via insertReminderIfNew and never calls Termii again", async () => {
  const { rows, deps } = fakeStore();
  const { client, calls } = fakeTermii(() => ({ ok: true, messageId: "termii-msg-1" }));
  const billRow = bill({ dueDay: 10 });

  await runReminders("2026-11-09", 12, { ...deps, termii: client, listCandidateBills: async () => [billRow] });
  const summary2 = await runReminders("2026-11-09", 12, { ...deps, termii: client, listCandidateBills: async () => [billRow] });

  assertEquals(summary2, { planned: 1, deduped: 1, sent: 0, retried: 0, failed: 0 });
  assertEquals(calls.length, 1, "Termii must only ever be called once for the same (bill, kind, date)");
  assertEquals(rows.length, 1, "no duplicate row should ever be inserted");
});

Deno.test("a failed send is retried exactly once on the next tick, then marked failed if it fails again", async () => {
  const { rows, deps } = fakeStore();
  const { client: failingClient } = fakeTermii(() => ({ ok: false, error: "insufficient balance" }));
  const billRow = bill({ dueDay: 10 });

  // Tick 1: first attempt fails -> retry pending, still 'scheduled'.
  const summary1 = await runReminders("2026-11-09", 12, {
    ...deps,
    termii: failingClient,
    listCandidateBills: async () => [billRow],
  });
  assertEquals(summary1, { planned: 1, deduped: 0, sent: 0, retried: 0, failed: 0 });
  assertEquals(rows[0].status, "scheduled");
  assertEquals(rows[0].retryCount, 1);

  // Tick 2: no new candidate bills this time (it's not newly due again),
  // but the pending retry should still be picked up and attempted again.
  const summary2 = await runReminders("2026-11-09", 12, {
    ...deps,
    termii: failingClient,
    listCandidateBills: async () => [],
  });
  assertEquals(summary2, { planned: 0, deduped: 0, sent: 0, retried: 0, failed: 1 });
  assertEquals(rows[0].status, "failed");
});

Deno.test("a failed send that succeeds on its one retry is marked sent, not failed", async () => {
  const { rows, deps } = fakeStore();
  let attempt = 0;
  const { client } = fakeTermii(() => {
    attempt++;
    return attempt === 1 ? { ok: false, error: "temporary" } : { ok: true, messageId: "termii-msg-2" };
  });
  const billRow = bill({ dueDay: 10 });

  await runReminders("2026-11-09", 12, { ...deps, termii: client, listCandidateBills: async () => [billRow] });
  assertEquals(rows[0].status, "scheduled");
  assertEquals(rows[0].retryCount, 1);

  const summary2 = await runReminders("2026-11-09", 12, { ...deps, termii: client, listCandidateBills: async () => [] });
  assertEquals(summary2.sent, 1);
  assertEquals(summary2.retried, 1);
  assertEquals(summary2.failed, 0);
  assertEquals(rows[0].status, "sent");
  assertEquals(rows[0].providerMessageId, "termii-msg-2");
});

Deno.test("a bill with no reminder due right now produces nothing and never touches Termii", async () => {
  const { deps } = fakeStore();
  const { client, calls } = fakeTermii(() => ({ ok: true, messageId: "unused" }));

  const summary = await runReminders("2026-11-01", 12, {
    ...deps,
    termii: client,
    listCandidateBills: async () => [bill({ dueDay: 10 })], // 9 days out, nothing due
  });

  assertEquals(summary, { planned: 0, deduped: 0, sent: 0, retried: 0, failed: 0 });
  assertEquals(calls.length, 0);
});
