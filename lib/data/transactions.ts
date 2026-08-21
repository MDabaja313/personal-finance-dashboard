import "server-only";

import { monthKey } from "@/lib/finance/dates";
import { mockTransactions } from "@/lib/mock";
import type { MonthKey, Transaction, TransactionKind } from "@/lib/types";

export interface TransactionFilters {
  month?: MonthKey;
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
 * clause in Phase 4.
 */
export async function getTransactions(filters: TransactionFilters = {}): Promise<Transaction[]> {
  let results: Transaction[] = [...mockTransactions];

  if (filters.month) {
    results = results.filter((t) => monthKey(t.date) === filters.month);
  }
  if (filters.accountId) {
    results = results.filter((t) => t.accountId === filters.accountId);
  }
  if (filters.categoryId) {
    results = results.filter((t) => t.categoryId === filters.categoryId);
  }
  if (filters.kind) {
    results = results.filter((t) => t.kind === filters.kind);
  }
  if (filters.search) {
    const query = filters.search.toLowerCase();
    results = results.filter((t) => t.merchant.toLowerCase().includes(query));
  }

  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getRecentTransactions(limit: number): Promise<Transaction[]> {
  return (await getTransactions()).slice(0, limit);
}

export async function getTransactionsForMonth(month: MonthKey): Promise<Transaction[]> {
  return getTransactions({ month });
}
