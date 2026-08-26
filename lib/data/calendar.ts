/**
 * Instant → calendar date in a named IANA timezone.
 *
 * Pure and client-free, like `lib/data/mappers.ts` and `lib/data/filters.ts`:
 * the instant is a parameter, never a clock read, so the tricky half of
 * `getToday()` — "which calendar date is it, in *this* zone, at *this*
 * instant" — is unit testable offline with fixed instants rather than being
 * hostage to the wall clock. `lib/data/clock.ts` supplies the real instant and
 * the owner's timezone; everything else about the conversion lives here.
 *
 * The conversion follows docs/database-schema.md §10 exactly, and the reason
 * it is spelled out there is worth restating: `Intl.DateTimeFormat`'s
 * *formatted string* is not a machine-readable contract. Separator, part
 * order, and zero-padding are locale/implementation details, even for
 * `'en-CA'`. So this reads structured `formatToParts()` output and assembles
 * `'YYYY-MM-DD'` itself, then validates the result through the same
 * `calendarDateFrom` validator every DB `DATE` column passes through — a
 * calendar date reaching the domain is shape-checked no matter where it came
 * from.
 */
import { calendarDateFrom } from "@/lib/data/mappers";
import { dataIntegrity } from "@/lib/errors";
import type { CalendarDate } from "@/lib/types";

/**
 * `Intl` gives the parts; this pins everything about them that is otherwise
 * locale-dependent. `calendar`/`numberingSystem` are explicit so a host with a
 * non-Gregorian or non-Latin default locale cannot produce a year like
 * "١٤٤٨" or a Buddhist-era year that would still be a well-formed 4-digit
 * string.
 */
const PART_OPTIONS = {
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
} as const;

/**
 * The calendar date `instant` falls on in `timeZone`, as a `CalendarDate`.
 *
 * `timeZone` is typed `unknown` on purpose: its real source is a database
 * column, and a `TEXT` column's runtime value is not proven by the row type.
 * An unusable zone fails as `data_integrity` — never a silent fallback to UTC,
 * which would quietly show the wrong day to a user east or west of it.
 */
export function calendarDateInTimeZone(instant: Date, timeZone: unknown): CalendarDate {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw dataIntegrity("Missing timezone on the owner profile.");
  }
  if (!Number.isFinite(instant.getTime())) {
    // Checked separately so an invalid instant is not misreported as an
    // invalid timezone — `formatToParts` throws a RangeError for both.
    throw dataIntegrity("Invalid instant for the owner's current date.");
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, ...PART_OPTIONS }).formatToParts(instant);
  } catch (cause) {
    // The zone string is arbitrary database text and never enters the message.
    throw dataIntegrity("Unrecognized timezone on the owner profile.", { cause });
  }

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw dataIntegrity("Incomplete date parts for the owner's current date.");
  }

  // Padding is re-applied rather than trusted: `'2-digit'` is a request, not a
  // guarantee, and `'numeric'` years are not padded at all.
  const assembled = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  return calendarDateFrom(assembled, "the owner's current date");
}
