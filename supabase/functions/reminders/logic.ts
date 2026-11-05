// Pure decision logic for the reminders job: given a bill (plus the
// account/plan settings that affect reminders) and "now", decide which
// reminders (if any) should fire. No DB, no network, no Deno.serve - fully
// unit-testable, which is where the real edge-case risk in this slice
// lives (the DB/Termii IO wrappers in index.ts are thin by comparison).
import { compareDates, diffDays, nextDayOfMonthOnOrAfter, type IsoDate } from "../_shared/date.ts";

export type ReminderKind = "due_3d" | "due_1d" | "daily_nudge";

export interface BillCandidate {
  billId: string;
  userId: string;
  phone: string;
  notifyChannel: "sms" | "whatsapp";
  smsOptedOut: boolean;
  name: string;
  amountKobo: number;
  dueDay: number; // 1-31, meaningful when recurrence === "monthly"
  recurrence: "monthly" | "once";
  dueDate: IsoDate | null; // set when recurrence === "once"
  paidKobo: number;
  nudgeHourUtc: number; // from the owning user's plan row
}

export interface PlannedReminder {
  billId: string;
  kind: ReminderKind;
  forDate: IsoDate;
  phone: string;
  message: string;
}

const naira = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});

function formatKobo(amountKobo: number): string {
  return naira.format(Math.round(amountKobo) / 100);
}

/** The next date this bill is due on/after `today`, or null if a one-off bill's due date has already passed. */
export function nextDueDate(bill: Pick<BillCandidate, "recurrence" | "dueDay" | "dueDate">, today: IsoDate): IsoDate | null {
  if (bill.recurrence === "once") {
    if (!bill.dueDate) throw new Error("a 'once' bill must have a dueDate");
    return compareDates(bill.dueDate, today) >= 0 ? bill.dueDate : null;
  }
  return nextDayOfMonthOnOrAfter(today, bill.dueDay);
}

export function remainingKobo(bill: Pick<BillCandidate, "amountKobo" | "paidKobo">): number {
  return Math.max(0, bill.amountKobo - bill.paidKobo);
}

/**
 * Kobo/day still needed to cover the bill's next occurrence by its due
 * date, mirroring billsteady-web's dailySetAside (same semantics: the full
 * remaining amount when due today or overdue, 0 once nothing is owed or a
 * one-off bill's date has already passed).
 */
export function dailySetAsideKobo(bill: BillCandidate, today: IsoDate): number {
  const remaining = remainingKobo(bill);
  if (remaining <= 0) return 0;

  const due = nextDueDate(bill, today);
  if (due === null) return 0;

  const daysLeft = diffDays(due, today);
  if (daysLeft <= 0) return remaining;
  return Math.ceil(remaining / daysLeft);
}

/**
 * Which reminders (if any) should fire for this bill right now. `nowUtcHour`
 * is 0-23; the daily nudge fires on any cron tick within the user's chosen
 * UTC hour (hour granularity, not exact-to-the-minute - see the migration
 * comment on plans.nudge_hour_utc for why).
 *
 * WhatsApp (notify_channel = 'whatsapp') is a known Phase 1 gap: Prompt 1.2
 * (WhatsApp reminders) is deliberately out of scope for this slice (needs
 * WhatsApp Business Cloud API approval this project doesn't have), so those
 * users get nothing from this function yet, by design, not by accident.
 */
export function planRemindersForBill(bill: BillCandidate, today: IsoDate, nowUtcHour: number): PlannedReminder[] {
  if (bill.notifyChannel !== "sms" || bill.smsOptedOut) return [];

  const reminders: PlannedReminder[] = [];

  const due = nextDueDate(bill, today);
  if (due !== null) {
    const daysLeft = diffDays(due, today);
    if (daysLeft === 3) {
      reminders.push({
        billId: bill.billId,
        kind: "due_3d",
        forDate: due,
        phone: bill.phone,
        message: `BillSteady: ${bill.name} (${formatKobo(remainingKobo(bill))}) is due in 3 days, on ${due}.`,
      });
    } else if (daysLeft === 1) {
      reminders.push({
        billId: bill.billId,
        kind: "due_1d",
        forDate: due,
        phone: bill.phone,
        message: `BillSteady: ${bill.name} (${formatKobo(remainingKobo(bill))}) is due tomorrow, ${due}.`,
      });
    }
  }

  if (nowUtcHour === bill.nudgeHourUtc) {
    const setAside = dailySetAsideKobo(bill, today);
    if (setAside > 0) {
      reminders.push({
        billId: bill.billId,
        kind: "daily_nudge",
        forDate: today,
        phone: bill.phone,
        message: `BillSteady: set aside ${formatKobo(setAside)} today toward ${bill.name}.`,
      });
    }
  }

  return reminders;
}
