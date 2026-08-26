import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import {
  assertRowLimit,
  containsPattern,
  effectiveDateBounds,
  isEmptyRange,
} from "@/lib/data/filters";
import { toTransaction } from "@/lib/data/mappers";
import type { TransactionRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
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
 * Explicit column list — never `select("*")`. `created_at` is deliberately
 * absent: it is an ordering key only (PostgREST can order by a column it does
 * not project), and it must never appear on the `Transaction` DTO.
 */
const TRANSACTION_COLUMNS = "id, account_id, date, merchant, kind, category_id, movement_id, amount_cents";

/**
 * The one query both reads share, so the ordering contract has exactly one
 * definition and `getRecentTransactions` cannot drift from `getTransactions`.
 *
 * `limit` is an internal parameter, not part of `TransactionFilters` — it
 * exists so a bounded read is a real `LIMIT` on the server rather than a slice
 * of a fully materialized list. (Caller-facing `limit`/`offset` pagination is
 * Checkpoint 4.)
 *
 * Every read here follows the unconditional DAL rule: a verified `getOwnerId()`
 * first, then an explicit `user_id` predicate on top of RLS, then
 * `mapDbError` before `data` is touched, then a mapper over the rows. No raw
 * row escapes.
 *
 * There is no `movements` query and no join to one: `Transaction.movementId`
 * is the plain `transactions.movement_id` column, and `authenticated` has no
 * SELECT grant on `movements` (nor needs one) — see the RLS/grants migration.
 */
async function readTransactions(
  filters: TransactionFilters,
  limit?: number
): Promise<Transaction[]> {
  const ownerId = await getOwnerId();

  const bounds = effectiveDateBounds(filters);
  // A non-overlapping intersection matches nothing by construction — return
  // `[]` rather than issuing a query whose result is already known. Auth is
  // still verified above, unconditionally.
  if (isEmptyRange(bounds)) return [];

  const supabase = await getDataClient();

  let filtered = supabase
    .from("transactions")
    .select(TRANSACTION_COLUMNS)
    .eq("user_id", ownerId);

  // `from`/`to` are both inclusive, hence gte/lte.
  if (bounds.from !== undefined) filtered = filtered.gte("date", bounds.from);
  if (bounds.to !== undefined) filtered = filtered.lte("date", bounds.to);

  if (filters.accountId) filtered = filtered.eq("account_id", filters.accountId);
  if (filters.categoryId) filtered = filtered.eq("category_id", filters.categoryId);
  if (filters.kind) filtered = filtered.eq("kind", filters.kind);
  // Case-insensitive substring, with every wildcard in the user's text
  // escaped to a literal — see lib/data/filters.ts. An empty string is
  // falsy and applies no filter at all, matching the legacy behavior.
  //
  // This is a `%…%` scan; there is no trigram index on `merchant` yet
  // (deferred by the Phase 4 index migration, docs/database-schema.md §8) and
  // adding one is a migration, not a Checkpoint 3 change.
  if (filters.search) filtered = filtered.ilike("merchant", containsPattern(filters.search));

  // `date DESC, created_at DESC, id ASC` — docs/database-schema.md §17.
  let ordered = filtered
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (limit !== undefined) ordered = ordered.limit(limit);

  const { data, error } = await ordered;

  if (error) throw mapDbError(error, "transactions");

  return (data as TransactionRow[]).map(toTransaction);
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
 * Phase 6 Checkpoint 3: reads `public.transactions`. Checkpoint 4 adds
 * validated `limit`/`offset` to `TransactionFilters`.
 */
export async function getTransactions(filters: TransactionFilters = {}): Promise<Transaction[]> {
  return readTransactions(filters);
}

/**
 * The `limit` most recent transactions, in the same
 * `date DESC, created_at DESC, id ASC` order as `getTransactions()`.
 *
 * A real bounded query — the `LIMIT` is applied by the database, not by
 * slicing a fully materialized list.
 */
export async function getRecentTransactions(limit: number): Promise<Transaction[]> {
  assertRowLimit(limit, "recent transactions");
  return readTransactions({}, limit);
}
