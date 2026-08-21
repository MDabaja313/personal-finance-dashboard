import type { CalendarDate, MonthKey } from "@/lib/types";

/**
 * Parses a 'YYYY-MM-DD' calendar date into local-time date components.
 * `new Date('YYYY-MM-DD')` parses as UTC midnight, which renders as the
 * previous day in any timezone west of UTC — never do that for financial dates.
 */
export function parseCalendarDate(date: CalendarDate): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Whole calendar days from `from` to `to` (negative if `to` precedes `from`).
 * Computed via Date.UTC on the parsed components, not local-midnight
 * subtraction — a local-time diff crosses DST transitions as 23- or 25-hour
 * days, producing an off-by-one. Date.UTC is immune: it never applies a
 * timezone offset, so the result is identical on every host timezone.
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromUTC = Date.UTC(fy, fm - 1, fd);
  const toUTC = Date.UTC(ty, tm - 1, td);
  return Math.round((toUTC - fromUTC) / 86_400_000);
}

/** 'YYYY-MM' month key for a calendar date, e.g. for grouping by budget period. */
export function monthKey(date: CalendarDate): MonthKey {
  return date.slice(0, 7);
}

const monthLabelFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
});

/** e.g. '2026-08' -> 'Aug 2026'. */
export function monthLabel(month: MonthKey): string {
  const [year, m] = month.split("-").map(Number);
  return monthLabelFormatter.format(new Date(year, m - 1, 1));
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [year, m] = month.split("-").map(Number);
  const total = year * 12 + (m - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, "0")}`;
}

/** Inclusive list of 'YYYY-MM' keys from `fromMonth` through `toMonth`. */
export function listMonths(fromMonth: MonthKey, toMonth: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  for (let current = fromMonth; current <= toMonth; current = addMonths(current, 1)) {
    months.push(current);
  }
  return months;
}

/** First calendar day of a 'YYYY-MM' month, e.g. '2026-08' -> '2026-08-01'. */
export function monthStart(month: MonthKey): CalendarDate {
  const [year, m] = month.split("-").map(Number);
  return `${year}-${String(m).padStart(2, "0")}-01`;
}

/**
 * Last calendar day of a 'YYYY-MM' month, e.g. '2026-08' -> '2026-08-31',
 * '2026-02' -> '2026-02-28', '2024-02' -> '2024-02-29' (leap year). Day 0 of
 * the following month (via Date.UTC) rolls back to the last day of this
 * month, which correctly accounts for variable month length and leap years
 * without hardcoding either. `new Date(Date.UTC(...))` takes one argument,
 * so it doesn't trip the zero-arg `new Date()` clock-read restriction.
 */
export function monthEnd(month: MonthKey): CalendarDate {
  const [year, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}
