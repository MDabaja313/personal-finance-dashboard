/**
 * The field-level building blocks every mutation schema is assembled from.
 *
 * Pure and dependency-light on purpose: Zod and `lib/types` only. No DAL, no
 * Supabase, no fixtures, no React, no `next/*`, no `process.env`, and no clock
 * — ESLint enforces every one of those for `lib/validation/**`, and
 * `lib/write-posture.test.ts` proves the fences fire.
 *
 * ## Two conventions that matter more than they look
 *
 * **An empty string is not a value.** An unfilled HTML input submits `""`,
 * never `undefined`, so every *optional* field here maps `""` to `undefined`
 * before validating. Without that, an untouched optional select would fail a
 * UUID check, and an untouched optional note would be stored as an empty
 * string rather than as "absent" — which is exactly the `null`/`undefined`
 * confusion `lib/data/mappers.ts` works to keep out of the domain, arriving
 * from the other direction.
 *
 * **`today` is a parameter, never a clock read.** `zNotFuture(today)` is a
 * factory for the same reason every `lib/finance/**` function takes `today`
 * explicitly: a validator that read the clock could not be tested at a fixed
 * date, and would silently disagree with the owner's timezone-derived
 * calendar day that `lib/data/clock.ts` supplies.
 */
import { z } from "zod";

import type { CalendarDate, MonthKey } from "@/lib/types";

/** Structural 'YYYY-MM-DD'. Calendar validity is a separate, later check. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM' with a real month number, mirroring the schema's CHECK constraints. */
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Application-level input bounds. The database has no length constraint on
 * these columns (`text`), so these are not a schema mirror — they exist so an
 * unbounded paste cannot reach storage, and so a name stays renderable in the
 * UI it was typed for.
 */
export const NAME_MAX_LENGTH = 120;
export const NOTE_MAX_LENGTH = 500;

/**
 * `""` (or whitespace) → `undefined`; everything else through untouched.
 *
 * Exported because every optional field needs it and a second implementation
 * would eventually disagree with this one about whitespace.
 */
export function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value;
}

/** A required row id — a `<select>` value, a hidden id field. */
export const zUuid = z.uuid({ error: "Select a valid option." });

/**
 * An optional row id. An unselected `<select>` submits `""`, which becomes
 * `undefined` — the shape the DTOs use for "not set" — rather than failing as
 * a malformed UUID.
 */
export const zOptionalUuid = z.preprocess(blankToUndefined, zUuid.optional());

/**
 * A required display name — an account, a category, a bill, a goal.
 *
 * Trimmed *before* the emptiness check, so a field holding only spaces is
 * rejected rather than stored as blank, and the trimmed value is what the
 * schema outputs: leading/trailing whitespace never reaches the database,
 * where it would defeat the case-insensitive uniqueness index on
 * `categories(user_id, lower(name))`.
 */
export const zName = z
  .string({ error: "Enter a name." })
  .trim()
  .min(1, { error: "Enter a name." })
  .max(NAME_MAX_LENGTH, { error: `Use ${NAME_MAX_LENGTH} characters or fewer.` });

/** Optional free text. Blank → `undefined`; otherwise trimmed and bounded. */
export const zOptionalNote = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .max(NOTE_MAX_LENGTH, { error: `Use ${NOTE_MAX_LENGTH} characters or fewer.` })
    .optional()
);

/**
 * Is this a date that actually exists?
 *
 * The structural check alone accepts '2026-02-30' and '2026-13-01'. The
 * round-trip through `Date.UTC` rejects both: a component that rolled over
 * (Feb 30 → Mar 2) comes back different from what went in.
 *
 * `Date.UTC` is used rather than local-midnight construction for the same
 * reason `lib/finance/dates.ts` uses it — a local-time construction near a DST
 * boundary can shift the day. It takes explicit arguments, so it is a pure
 * conversion and not a clock read.
 *
 * Years below 100 are rejected as a side effect (`Date.UTC(99, …)` means 1999),
 * which is correct here: a two-digit year is a typo, not a financial date.
 */
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));

  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

/**
 * A 'YYYY-MM-DD' calendar date that exists on the calendar.
 *
 * Stricter than `calendarDateFrom()` in `lib/data/mappers.ts`, deliberately:
 * that validator reads a `DATE` column Postgres already guaranteed, while this
 * one reads whatever was posted to a Server Action endpoint.
 */
export const zCalendarDate: z.ZodType<CalendarDate, string> = z
  .string({ error: "Enter a date." })
  .trim()
  .regex(CALENDAR_DATE_PATTERN, { error: "Enter a date as YYYY-MM-DD." })
  .refine(isRealCalendarDate, { error: "Enter a real calendar date." });

/**
 * A 'YYYY-MM' budget/snapshot period — **structural only**.
 *
 * There is nothing further to check: unlike a date, every well-formed month
 * key denotes a month that exists. A range check ("not before the account was
 * opened", "not more than a year ahead") is a per-operation policy and belongs
 * with the operation, not in the primitive.
 */
export const zMonthKey: z.ZodType<MonthKey, string> = z
  .string({ error: "Enter a month." })
  .trim()
  .regex(MONTH_KEY_PATTERN, { error: "Enter a month as YYYY-MM." });

/**
 * A calendar date no later than `today`.
 *
 * `today` is supplied by the caller — in production from `getToday()`, which
 * derives it from the owner's `profiles.timezone`, so "the future" means the
 * future where the person actually is, not where the server is.
 *
 * The comparison is a plain string comparison, which is exact for
 * 'YYYY-MM-DD': the format is fixed-width and zero-padded, so lexicographic
 * and chronological order coincide. No `Date` object is constructed, so no
 * timezone can enter the comparison.
 *
 * A malformed `today` throws immediately, and that is deliberately *not* a
 * validation issue: `today` comes from this application, not from the person
 * filling in the form. Comparing against a garbage bound would silently
 * accept or reject everything, so it fails loudly at the call site instead.
 */
export function zNotFuture(today: CalendarDate): z.ZodType<CalendarDate, string> {
  if (!CALENDAR_DATE_PATTERN.test(today)) {
    throw new Error("zNotFuture requires a 'YYYY-MM-DD' today.");
  }

  return zCalendarDate.refine((value) => value <= today, {
    error: "That date is in the future.",
  });
}
