import { assertEquals } from "jsr:@std/assert@1";
import { dailySetAsideKobo, nextDueDate, planRemindersForBill, remainingKobo, type BillCandidate } from "./logic.ts";

function bill(overrides: Partial<BillCandidate> = {}): BillCandidate {
  return {
    billId: "bill-1",
    userId: "user-1",
    phone: "+2348012345678",
    notifyChannel: "sms",
    smsOptedOut: false,
    name: "Electricity",
    amountKobo: 10_000_00,
    dueDay: 20,
    recurrence: "monthly",
    dueDate: null,
    paidKobo: 0,
    nudgeHourUtc: 7,
    ...overrides,
  };
}

Deno.test("nextDueDate: monthly bill due on the 31st clamps to Feb 28 in a non-leap year", () => {
  assertEquals(nextDueDate(bill({ dueDay: 31 }), "2027-02-01"), "2027-02-28");
});

Deno.test("nextDueDate: a one-off bill whose date already passed returns null", () => {
  assertEquals(nextDueDate(bill({ recurrence: "once", dueDate: "2026-10-01" }), "2026-11-04"), null);
});

Deno.test("nextDueDate: a one-off bill still ahead returns its date", () => {
  assertEquals(nextDueDate(bill({ recurrence: "once", dueDate: "2026-12-25" }), "2026-11-04"), "2026-12-25");
});

Deno.test("remainingKobo: nets off a partial payment", () => {
  assertEquals(remainingKobo(bill({ amountKobo: 10_000_00, paidKobo: 4_000_00 })), 6_000_00);
});

Deno.test("remainingKobo: never goes negative", () => {
  assertEquals(remainingKobo(bill({ amountKobo: 10_000_00, paidKobo: 15_000_00 })), 0);
});

Deno.test("dailySetAsideKobo: splits the remaining amount evenly across days left", () => {
  // dueDay 20, today 10th -> 10 days left
  assertEquals(dailySetAsideKobo(bill({ dueDay: 20, amountKobo: 10_000_00 }), "2026-11-10"), 10_000_00 / 10);
});

Deno.test("dailySetAsideKobo: the full remaining amount when due today", () => {
  assertEquals(dailySetAsideKobo(bill({ dueDay: 10, amountKobo: 500_00 }), "2026-11-10"), 500_00);
});

Deno.test("dailySetAsideKobo: 0 once the bill is fully paid", () => {
  assertEquals(dailySetAsideKobo(bill({ amountKobo: 1_000_00, paidKobo: 1_000_00 }), "2026-11-01"), 0);
});

Deno.test("planRemindersForBill: fires due_3d exactly 3 days out", () => {
  // today 2026-11-07, due 2026-11-10 -> 3 days
  const reminders = planRemindersForBill(bill({ dueDay: 10 }), "2026-11-07", 12 /* not the nudge hour */);
  assertEquals(reminders.length, 1);
  assertEquals(reminders[0].kind, "due_3d");
  assertEquals(reminders[0].forDate, "2026-11-10");
});

Deno.test("planRemindersForBill: fires due_1d exactly 1 day out", () => {
  const reminders = planRemindersForBill(bill({ dueDay: 10 }), "2026-11-09", 12);
  assertEquals(reminders.length, 1);
  assertEquals(reminders[0].kind, "due_1d");
});

Deno.test("planRemindersForBill: no due-date reminder when neither 3 nor 1 day out", () => {
  const reminders = planRemindersForBill(bill({ dueDay: 10 }), "2026-11-02", 12);
  assertEquals(reminders.filter((r) => r.kind !== "daily_nudge"), []);
});

Deno.test("planRemindersForBill: nudge fires only in the user's chosen UTC hour, and only while money is still owed", () => {
  const b = bill({ dueDay: 20, amountKobo: 5_000_00, nudgeHourUtc: 7 });

  const wrongHour = planRemindersForBill(b, "2026-11-01", 8);
  assertEquals(wrongHour.find((r) => r.kind === "daily_nudge"), undefined);

  const rightHour = planRemindersForBill(b, "2026-11-01", 7);
  const nudge = rightHour.find((r) => r.kind === "daily_nudge");
  assertEquals(nudge?.forDate, "2026-11-01");

  const fullyPaid = bill({ dueDay: 20, amountKobo: 5_000_00, paidKobo: 5_000_00, nudgeHourUtc: 7 });
  const noNudgeWhenPaid = planRemindersForBill(fullyPaid, "2026-11-01", 7);
  assertEquals(noNudgeWhenPaid.find((r) => r.kind === "daily_nudge"), undefined);
});

Deno.test("planRemindersForBill: an opted-out user gets nothing, even 1 day out with the nudge hour matching", () => {
  const reminders = planRemindersForBill(
    bill({ dueDay: 10, smsOptedOut: true, nudgeHourUtc: 7 }),
    "2026-11-09",
    7,
  );
  assertEquals(reminders, []);
});

Deno.test("planRemindersForBill: a whatsapp user gets nothing in Phase 1 (WhatsApp is deferred)", () => {
  const reminders = planRemindersForBill(
    bill({ dueDay: 10, notifyChannel: "whatsapp", nudgeHourUtc: 7 }),
    "2026-11-09",
    7,
  );
  assertEquals(reminders, []);
});

Deno.test("planRemindersForBill: can fire both a due-date reminder and the nudge on the same tick", () => {
  const b = bill({ dueDay: 10, amountKobo: 3_000_00, nudgeHourUtc: 7 });
  const reminders = planRemindersForBill(b, "2026-11-09", 7); // 1 day out AND the nudge hour
  const kinds = reminders.map((r) => r.kind).sort();
  assertEquals(kinds, ["daily_nudge", "due_1d"]);
});
