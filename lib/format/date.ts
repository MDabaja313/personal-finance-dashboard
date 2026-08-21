import { monthLabel, parseCalendarDate } from "@/lib/finance/dates";
import type { CalendarDate } from "@/lib/types";

// Re-exported so display code consistently imports formatting helpers from
// lib/format/*; lib/finance/dates remains the single source of truth.
export { monthLabel };

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatCalendarDate(date: CalendarDate): string {
  return dateFormatter.format(parseCalendarDate(date));
}
