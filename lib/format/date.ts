import type { CalendarDate } from "@/lib/types";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * Parses a 'YYYY-MM-DD' calendar date into local-time date components.
 * `new Date('YYYY-MM-DD')` parses as UTC midnight, which renders as the
 * previous day in any timezone west of UTC — never do that for financial dates.
 */
function parseCalendarDate(date: CalendarDate): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatCalendarDate(date: CalendarDate): string {
  return dateFormatter.format(parseCalendarDate(date));
}

/** 'YYYY-MM' month key for a calendar date, e.g. for grouping by budget period. */
export function monthKey(date: CalendarDate): string {
  return date.slice(0, 7);
}
