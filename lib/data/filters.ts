/**
 * Pure filter/parameter translation for the Supabase-backed DAL reads.
 *
 * No Supabase client, no `server-only`, no clock, no fixtures — every export
 * here is a total function of its arguments, exactly like `lib/data/mappers.ts`
 * is on the row→DTO side. That is what lets `npm test` assert the tricky parts
 * (bound intersection, `LIKE` escaping, limit validation) offline, with no
 * database, while the parity suite proves the same code against real rows.
 *
 * These helpers live in their own module rather than inside
 * `lib/data/transactions.ts` specifically so importing them cannot drag
 * `lib/data/supabase.ts` (and therefore `next/headers`) into a unit test.
 */
import { dataIntegrity } from "@/lib/errors";
import { monthEnd, monthStart } from "@/lib/finance/dates";
import type { CalendarDate, MonthKey } from "@/lib/types";

// ============================================================
// Inclusive date bounds
// ============================================================

export interface DateBoundsInput {
  month?: MonthKey;
  from?: CalendarDate;
  to?: CalendarDate;
}

export interface DateBounds {
  from?: CalendarDate;
  to?: CalendarDate;
}

/** The tighter (later) of two optional lower bounds — undefined means "no bound". */
function laterOf(a: CalendarDate | undefined, b: CalendarDate | undefined): CalendarDate | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** The tighter (earlier) of two optional upper bounds — undefined means "no bound". */
function earlierOf(a: CalendarDate | undefined, b: CalendarDate | undefined): CalendarDate | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

/**
 * Resolves `month` + explicit `from`/`to` into a single inclusive range.
 *
 * `month` is sugar for the equivalent `monthStart`/`monthEnd` range, so there
 * is one definition of "date range" rather than two: supplying it alongside
 * explicit `from`/`to` **intersects** rather than overrides — the tighter
 * bound wins on each side.
 *
 * Bounds stay plain `CalendarDate` strings (never `Date` objects) all the way
 * into the `gte`/`lte` predicates: 'YYYY-MM-DD' is lexicographically ordered
 * and is also exactly what Postgres parses as a `DATE`, so the comparison is
 * correct and inherently timezone-safe on both sides of the wire.
 */
export function effectiveDateBounds(input: DateBoundsInput): DateBounds {
  let from = input.from;
  let to = input.to;

  if (input.month) {
    from = laterOf(from, monthStart(input.month));
    to = earlierOf(to, monthEnd(input.month));
  }

  const bounds: DateBounds = {};
  if (from !== undefined) bounds.from = from;
  if (to !== undefined) bounds.to = to;
  return bounds;
}

/**
 * True when the intersection collapsed to nothing (`from` strictly after
 * `to`). Such a range must return `[]` and never throw — the caller
 * short-circuits on it rather than issuing a query that is guaranteed to
 * match no rows.
 */
export function isEmptyRange(bounds: DateBounds): boolean {
  return bounds.from !== undefined && bounds.to !== undefined && bounds.from > bounds.to;
}

// ============================================================
// LIKE / ILIKE pattern escaping
// ============================================================

/**
 * Characters that must be neutralized before user text can be embedded in a
 * PostgREST `ilike` value.
 *
 * - `%` and `_` are SQL `LIKE` wildcards.
 * - `\` is Postgres's default `LIKE` escape character, so it has to escape
 *   itself or it would consume the character after it.
 * - `*` is **PostgREST's own alias for `%`** in `like`/`ilike` filter values.
 *   This one is not a SQL rule and is not visible from the SQL side at all;
 *   it was found empirically against the local stack (`merchant=ilike.*`
 *   returns every row, and `%S*ell%` matches "Shell Gas Station"), which is
 *   exactly why this list is not derived by inspection.
 *
 * One `String.replace` pass, not a chain of them: escaping `\` in a separate
 * pass from `%` would re-escape the backslashes the `%` pass just introduced.
 */
const LIKE_SPECIAL_CHARS = /[\\%_*]/g;

/** Escapes every `LIKE`/PostgREST wildcard so the text matches literally. */
export function escapeLikePattern(text: string): string {
  return text.replace(LIKE_SPECIAL_CHARS, (character) => `\\${character}`);
}

/**
 * User search text → a case-insensitive *substring* pattern.
 *
 * This is the `ilike` equivalent of the fixture oracle's
 * `merchant.toLowerCase().includes(query)`: the wrapping `%` are the only
 * wildcards in the resulting pattern, and everything the user typed is
 * literal.
 */
export function containsPattern(text: string): string {
  return `%${escapeLikePattern(text)}%`;
}

// ============================================================
// Limit validation
// ============================================================

/**
 * Validates a caller-supplied row limit before it reaches a query.
 *
 * Same rule and same failure mode as `getNetWorthHistory`'s `months` check: a
 * negative or non-safe-integer limit is a caller bug, not a value to silently
 * coerce, so it fails as `data_integrity` rather than being clamped. Zero is
 * permitted — it is a legitimate "no rows wanted" request and matches the
 * legacy `slice(0, 0)` behavior.
 *
 * `subject` is a short developer-authored noun, never user input and never row
 * data (see lib/errors.ts's message rule).
 */
export function assertRowLimit(limit: number, subject: string): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw dataIntegrity(`Invalid limit value for ${subject}.`);
  }
}
