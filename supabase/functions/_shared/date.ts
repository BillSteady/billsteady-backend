// Plain ISO (yyyy-mm-dd) date helpers, timezone-free (no Date-object drift).
//
// This is a deliberate, minimal port of the same algorithm proven out in
// billsteady-web's src/lib/date.ts (19 passing tests there, including the
// month-end-clamping edge cases this reminders function also relies on).
// It's duplicated rather than shared across repos because there's no
// package boundary between a Vite/browser app and a Deno Edge Function to
// share code through without publishing an npm package, which is out of
// scope for this slice. Keep the two in sync by hand if the algorithm ever
// changes - `weekday()` is dropped here since reminders never needs payday
// logic, only due-date logic.

export type IsoDate = string;

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function parse(date: IsoDate): Ymd {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function format({ y, m, d }: Ymd): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  const lengths = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[m - 1];
}

function toEpochDay({ y, m, d }: Ymd): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045
  );
}

function fromEpochDay(epochDay: number): Ymd {
  const j = epochDay + 32044;
  const g = Math.floor(j / 146097);
  const dg = j % 146097;
  const c = Math.floor(((Math.floor(dg / 36524) + 1) * 3) / 4);
  const dc = dg - c * 36524;
  const b = Math.floor(dc / 1461);
  const db = dc % 1461;
  const a = Math.floor(((Math.floor(db / 365) + 1) * 3) / 4);
  const da = db - a * 365;
  const y = g * 400 + c * 100 + b * 4 + a;
  const mm = Math.floor((da * 5 + 308) / 153) - 2;
  const d = da - Math.floor(((mm + 4) * 153) / 5) + 122;
  const yReal = y - 4800 + Math.floor((mm + 2) / 12);
  const mReal = ((mm + 2) % 12) + 1;
  return { y: yReal, m: mReal, d: d + 1 };
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return format(fromEpochDay(toEpochDay(parse(date)) + days));
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDay(parse(a)) - toEpochDay(parse(b));
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return diffDays(a, b);
}

/** Same day-of-month next month, clamped to that month's length (e.g. 31st in Feb -> 28th/29th). */
export function addMonthsClamped(date: IsoDate, months: number): IsoDate {
  const { y, m, d } = parse(date);
  const total = m - 1 + months;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12 + 1;
  const clampedDay = Math.min(d, daysInMonth(yy, mm));
  return format({ y: yy, m: mm, d: clampedDay });
}

/** The next date on/after `from` whose day-of-month is `dayOfMonth`, clamped per month. */
export function nextDayOfMonthOnOrAfter(from: IsoDate, dayOfMonth: number): IsoDate {
  const { y, m } = parse(from);
  const clampedThisMonth = Math.min(dayOfMonth, daysInMonth(y, m));
  const candidate = format({ y, m, d: clampedThisMonth });
  if (compareDates(candidate, from) >= 0) return candidate;

  const nextMonthFirst = addMonthsClamped(format({ y, m, d: 1 }), 1);
  const { y: ny, m: nm } = parse(nextMonthFirst);
  const clampedNextMonth = Math.min(dayOfMonth, daysInMonth(ny, nm));
  return format({ y: ny, m: nm, d: clampedNextMonth });
}
