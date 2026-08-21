import "server-only";

import { monthEnd, monthStart } from "@/lib/finance/dates";
import { mockTransactions } from "@/lib/mock";
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
 * Filtering happens here, server-side — the simplest correct approach for
 * a page reading URL searchParams: no client fetching, no API route,
 * shareable/bookmarkable URLs, and it maps directly onto a SQL WHERE
 * clause in Phase 6.
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
 * docs/database-schema.md. The mock fixture array's index stands in for
 * `created_at` (a later fixture entry is a later "created_at"); the index
 * is used only to sort and never appears on a returned `Transaction`.
 */
export async function getTransactions(filters: TransactionFilters = {}): Promise<Transaction[]> {
  let effectiveFrom = filters.from;
  let effectiveTo = filters.to;
  if (filters.month) {
    effectiveFrom = laterOf(effectiveFrom, monthStart(filters.month));
    effectiveTo = earlierOf(effectiveTo, monthEnd(filters.month));
  }

  let results = mockTransactions.map((t, index) => ({ t, index }));

  if (effectiveFrom !== undefined) {
    const from = effectiveFrom;
    results = results.filter(({ t }) => t.date >= from);
  }
  if (effectiveTo !== undefined) {
    const to = effectiveTo;
    results = results.filter(({ t }) => t.date <= to);
  }
  if (filters.accountId) {
    results = results.filter(({ t }) => t.accountId === filters.accountId);
  }
  if (filters.categoryId) {
    results = results.filter(({ t }) => t.categoryId === filters.categoryId);
  }
  if (filters.kind) {
    results = results.filter(({ t }) => t.kind === filters.kind);
  }
  if (filters.search) {
    const query = filters.search.toLowerCase();
    results = results.filter(({ t }) => t.merchant.toLowerCase().includes(query));
  }

  results.sort((a, b) => {
    if (a.t.date !== b.t.date) return b.t.date.localeCompare(a.t.date);
    if (a.index !== b.index) return b.index - a.index;
    return a.t.id.localeCompare(b.t.id);
  });

  return results.map(({ t }) => t);
}

export async function getRecentTransactions(limit: number): Promise<Transaction[]> {
  return (await getTransactions()).slice(0, limit);
}
