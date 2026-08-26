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

// ============================================================
// Pagination
// ============================================================

/**
 * The largest window a single paginated transaction read may request.
 *
 * A named ceiling rather than an ad-hoc number: it is what stops a
 * URL-supplied page number from turning into an arbitrarily large `Range`
 * header, and it is the value `/transactions` sizes its own page count
 * against. Over-limit is **rejected**, not clamped — silently returning fewer
 * rows than asked for is the coercion this codebase avoids everywhere else.
 */
export const MAX_TRANSACTION_LIMIT = 500;

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Zero-based, inclusive on both ends — exactly PostgREST's `.range()`. */
export interface PageRange {
  from: number;
  to: number;
}

/**
 * Validates caller-supplied `limit`/`offset` into a `.range()` window, or
 * `undefined` when no pagination was requested.
 *
 * The rules, none of which coerce:
 *
 * - `offset` must be a non-negative safe integer; it defaults to 0.
 * - `limit`, when present, must be a *positive* safe integer no greater than
 *   `MAX_TRANSACTION_LIMIT`. Zero is rejected here — unlike `assertRowLimit`,
 *   where zero is a meaningful "no rows wanted" — because a paginated page of
 *   size zero is a caller bug, not a request.
 * - An `offset` above zero with no `limit` is rejected rather than being
 *   turned into an open-ended range: an unbounded tail is not pagination, and
 *   inventing a ceiling for it would be the silent coercion this function
 *   exists to prevent.
 *
 * Omitting both leaves the read exactly as it was — the full-query contract
 * `getTransactions()` still owes its internal and parity callers.
 */
export function resolvePageRange(input: PaginationInput, subject: string): PageRange | undefined {
  const { limit, offset } = input;

  let start = 0;
  if (offset !== undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw dataIntegrity(`Invalid offset value for ${subject}.`);
    }
    start = offset;
  }

  if (limit === undefined) {
    if (start > 0) throw dataIntegrity(`A pagination offset requires a limit for ${subject}.`);
    return undefined;
  }

  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw dataIntegrity(`Invalid limit value for ${subject}.`);
  }
  if (limit > MAX_TRANSACTION_LIMIT) {
    throw dataIntegrity(`Limit exceeds the maximum for ${subject}.`);
  }

  return { from: start, to: start + limit - 1 };
}

/** One planned query: a `TransactionFilters` `offset`/`limit` pair. */
export interface FetchWindow {
  offset: number;
  limit: number;
}

/**
 * Splits "I need the first `need` rows" into consecutive bounded queries.
 *
 * `MAX_TRANSACTION_LIMIT` is the ceiling on **one query**, and it must not
 * double as a ceiling on how far back a caller can read: transaction history
 * is the one thing a finance app can never make unreachable. So a request
 * larger than the ceiling becomes several queries over the same filters and
 * the same ordering, rather than a refusal or a truncation.
 *
 * The windows are contiguous, disjoint, and in order — window *n* starts
 * exactly where window *n − 1* ended — so concatenating their results
 * reproduces the prefix of the single ordered result set that one big query
 * would have returned, with no duplicated or skipped row at the 500/1000/…
 * boundaries. That correctness rests on the DAL applying `.range()` *after*
 * its ordering chain, which is where the ordering contract is defined.
 *
 * **Lazy on purpose.** With no arbitrary page ceiling, `need` may legitimately
 * be enormous, and materializing a window per 500 rows up front would be the
 * one way a large page number could hurt before a single query ran. A
 * generator costs one window at a time, and the caller stops pulling the
 * moment a window comes back short — so a deep page against a small history
 * performs exactly one query.
 */
export function* iterateFetchWindows(
  need: number,
  maxWindow: number = MAX_TRANSACTION_LIMIT
): Generator<FetchWindow> {
  if (!Number.isSafeInteger(need) || need <= 0) {
    throw dataIntegrity("Invalid row count for a transaction fetch plan.");
  }
  if (!Number.isSafeInteger(maxWindow) || maxWindow <= 0) {
    throw dataIntegrity("Invalid window size for a transaction fetch plan.");
  }

  for (let offset = 0; offset < need; offset += maxWindow) {
    yield { offset, limit: Math.min(maxWindow, need - offset) };
  }
}

/**
 * The whole plan as an array — the testable form of `iterateFetchWindows`.
 *
 * Only for bounded `need` values: it materializes every window, which is
 * precisely what the production path avoids. `fetchPrefix` uses the generator.
 */
export function planFetchWindows(
  need: number,
  maxWindow: number = MAX_TRANSACTION_LIMIT
): FetchWindow[] {
  return [...iterateFetchWindows(need, maxWindow)];
}

// ============================================================
// Cumulative reveal ("Load more") paging
// ============================================================

/** A resolved `page` URL parameter and the bounded read it implies. */
export interface RevealPlan {
  /** Positive safe integer. */
  page: number;
  /** Rows to render: `pageSize * page`. */
  revealed: number;
  /** Rows to request: `revealed + 1`, the extra one being the has-more probe. */
  need: number;
}

/**
 * Resolves a `?page=` URL parameter into a cumulative reveal.
 *
 * There is deliberately **no maximum page and no maximum reveal**. An
 * arbitrary business ceiling — 2,000 pages, 50,000 rows, any number — makes
 * some finite history permanently unreachable, which is not a trade a finance
 * app gets to make. The only limit is arithmetic: a page is valid when it is a
 * positive safe integer *and* `pageSize * page` *and* that plus the probe row
 * are all safe integers. Beyond that the numbers stop being trustworthy, so
 * the input is treated as malformed and falls back to page 1 rather than
 * silently rendering a wrong window.
 *
 * A large-but-valid page is not a public query surface here: the route is
 * behind the owner guard, every underlying query is capped at
 * `MAX_TRANSACTION_LIMIT`, and the windowed read stops at the first short
 * result — so a huge page against a small history is one query, not thousands.
 *
 * Malformed input (`abc`, `-1`, `0`, `1.5`, an empty value, an absent value)
 * all resolve to page 1.
 */
export function resolveRevealPage(raw: string | undefined, pageSize: number): RevealPlan {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    // A developer-supplied constant, not user input — a bug, not a fallback.
    throw dataIntegrity("Invalid page size for a transaction reveal.");
  }

  const firstPage: RevealPlan = { page: 1, revealed: pageSize, need: pageSize + 1 };

  // Digits only: rejects '-1', '1.5', '1e5', ' 2', '' and 'abc' without
  // relying on Number()'s much looser coercion.
  if (raw === undefined || !/^\d+$/.test(raw)) return firstPage;

  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page < 1) return firstPage;

  const revealed = pageSize * page;
  if (!Number.isSafeInteger(revealed)) return firstPage;

  const need = revealed + 1;
  if (!Number.isSafeInteger(need)) return firstPage;

  return { page, revealed, need };
}
