/**
 * The fixture-backed DAL — the *parity oracle*.
 *
 * These are the exact function bodies that lived in `lib/data/**` through
 * Phases 0–5, extracted here verbatim in Phase 6 Checkpoint 1. Nothing about
 * their behavior was changed by the move: same filtering, same ordering, same
 * `undefined` handling, same `getNetWorthHistory(0)` semantics, same
 * `MOCK_TODAY`.
 *
 * Two jobs:
 *
 *  1. **Offline contract definition.** `lib/data/ordering.test.ts` and
 *     `lib/data/transactions.test.ts` assert against this module, so the
 *     legacy behavioral contract keeps running under `npm test` with no
 *     database, no network, and its original fixture-slug ids — even after
 *     `lib/data/**` goes to Supabase.
 *  2. **Parity oracle.** From Checkpoint 2 onward, `npm run test:parity`
 *     compares the Supabase-backed DAL against these functions, translating
 *     fixture slugs to their deterministic seeded UUIDs
 *     (`scripts/seed-identity.ts`) *before* applying any id-sensitive
 *     ordering rule.
 *
 * During Checkpoint 1 the production `lib/data/**` functions simply delegate
 * here, so application behavior is unchanged while the Supabase plumbing is
 * built alongside it. This module is retained after the swap (locked rule 17)
 * — it is the evidence that nothing moved.
 *
 * `app/**` and `components/**` must never import this, exactly as they must
 * never import any other `lib/mock/**` module (enforced in eslint.config.mjs).
 */
import { monthEnd, monthStart } from "@/lib/finance/dates";
import {
  MOCK_TODAY,
  mockAccounts,
  mockBills,
  mockBudgets,
  mockCategories,
  mockGoals,
  mockNetWorthHistory,
  mockTransactions,
} from "@/lib/mock";
import type {
  Account,
  Bill,
  Budget,
  CalendarDate,
  Category,
  Goal,
  MonthKey,
  NetWorthSnapshot,
  Transaction,
} from "@/lib/types";

// Type-only, therefore erased at compile time — no runtime dependency from
// lib/mock/** back into lib/data/**. Imported rather than re-declared so the
// oracle's filter surface can never drift from the production one it is
// supposed to be the reference implementation of.
import type { TransactionFilters } from "@/lib/data/transactions";

// ============================================================
// accounts
// ============================================================

/** Ordering: `name ASC, id ASC`. */
export async function getAccounts(): Promise<Account[]> {
  return [...mockAccounts].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

// ============================================================
// categories
// ============================================================

/** Ordering: `name ASC, id ASC`. */
export async function getCategories(): Promise<Category[]> {
  return [...mockCategories].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

// ============================================================
// transactions
// ============================================================

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
 * `from`/`to` are both inclusive, compared as plain `CalendarDate` strings
 * (never `Date` objects) — 'YYYY-MM-DD' is lexicographically ordered, so this
 * is correct and inherently timezone-safe. `month` is sugar for the equivalent
 * `monthStart`/`monthEnd` range: supplying it alongside explicit `from`/`to`
 * intersects rather than overrides (the tighter bound wins on each side). A
 * non-overlapping intersection returns `[]`, never throws.
 *
 * Ordering is `date DESC, created_at DESC, id ASC`. The fixture array's index
 * stands in for `created_at` (a later fixture entry is a later "created_at");
 * the index is used only to sort and never appears on a returned
 * `Transaction`.
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

// ============================================================
// budgets
// ============================================================

/**
 * Ordering: `category_id ASC, id ASC` — a deterministic *technical* order
 * only, not a display order. Callers that render a budget list apply their own
 * semantic order using category names they already fetch.
 */
export async function getBudgets(period: MonthKey): Promise<Budget[]> {
  return mockBudgets
    .filter((budget) => budget.period === period)
    .slice()
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.id.localeCompare(b.id));
}

// ============================================================
// bills
// ============================================================

/** Ordering: `due_date ASC, name ASC, id ASC`. */
function byDueDate(a: Bill, b: Bill): number {
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

export async function getBills(): Promise<Bill[]> {
  return [...mockBills].sort(byDueDate);
}

/**
 * Soonest due date first — an overdue bill sorts to the top. Deliberately
 * applies no `today` filter.
 */
export async function getUpcomingBills(limit: number): Promise<Bill[]> {
  return [...mockBills].sort(byDueDate).slice(0, limit);
}

// ============================================================
// goals
// ============================================================

/**
 * Ordering: `target_date ASC NULLS LAST, name ASC, id ASC`. A goal with no
 * target date sorts after every goal that has one.
 */
export async function getGoals(): Promise<Goal[]> {
  return [...mockGoals].sort((a, b) => {
    if (a.targetDate === undefined && b.targetDate === undefined) {
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    }
    if (a.targetDate === undefined) return 1;
    if (b.targetDate === undefined) return -1;
    return (
      a.targetDate.localeCompare(b.targetDate) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
    );
  });
}

// ============================================================
// net worth
// ============================================================

/**
 * Most recent `months` snapshots, oldest first. Omit for the full history.
 *
 * Note `months === 0`: `slice(-0)` is `slice(0)`, so zero returns the *whole*
 * history rather than an empty list. That is the established contract and
 * Phase 6 preserves it exactly — the Supabase implementation applies a `LIMIT`
 * only for a positive `months`.
 */
export async function getNetWorthHistory(months?: number): Promise<NetWorthSnapshot[]> {
  const sorted = [...mockNetWorthHistory].sort((a, b) => a.month.localeCompare(b.month));
  if (months === undefined) return sorted;
  return sorted.slice(-months);
}

// ============================================================
// clock
// ============================================================

/** The fixed mock-phase "today". */
export async function getToday(): Promise<CalendarDate> {
  return MOCK_TODAY;
}
