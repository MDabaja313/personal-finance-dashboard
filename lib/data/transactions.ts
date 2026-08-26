import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { CalendarDate, MonthKey, Transaction, TransactionKind } from "@/lib/types";

export interface TransactionFilters {
  /** Sugar for `from: monthStart(month), to: monthEnd(month)` — combines with explicit from/to by intersection, not override. */
  month?: MonthKey;
  /** Inclusive lower bound. */
  from?: CalendarDate;
  /** Inclusive upper bound. */
  to?: CalendarDate;
  accountId?: string;
  categoryId?: string;
  kind?: TransactionKind;
  /** Matches against merchant name, case-insensitive substring. */
  search?: string;
}

/**
 * Filtering happens here, server-side — the simplest correct approach for
 * a page reading URL searchParams: no client fetching, no API route,
 * shareable/bookmarkable URLs, and it maps directly onto a SQL WHERE
 * clause.
 *
 * `from`/`to` are both inclusive, compared as plain `CalendarDate` strings
 * (never `Date` objects) — 'YYYY-MM-DD' is lexicographically ordered, so
 * this is correct and inherently timezone-safe. `month` is sugar for the
 * equivalent `monthStart`/`monthEnd` range, so there is one definition of
 * "date range" rather than two: supplying `month` alongside explicit
 * `from`/`to` intersects rather than overrides (the tighter bound wins on
 * each side). A non-overlapping intersection returns `[]`, never throws.
 *
 * Ordering is `date DESC, created_at DESC, id ASC` — see
 * docs/database-schema.md. `created_at` never appears on the returned
 * `Transaction`.
 *
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle, which holds
 * the bound-intersection logic and the fixture-index stand-in for
 * `created_at`. Checkpoint 3 replaces the body with the filter→query
 * translation (bound intersection stays in TypeScript, `search` becomes an
 * escaped `ilike`), and Checkpoint 4 adds validated `limit`/`offset`.
 */
export async function getTransactions(filters: TransactionFilters = {}): Promise<Transaction[]> {
  return oracle.getTransactions(filters);
}

export async function getRecentTransactions(limit: number): Promise<Transaction[]> {
  return oracle.getRecentTransactions(limit);
}
