import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { assertRowLimit } from "@/lib/data/filters";
import { toBill } from "@/lib/data/mappers";
import type { BillOccurrenceRow, BillRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Bill } from "@/lib/types";

/** Explicit column lists — never `select("*")`. */
const BILL_COLUMNS = "id, name, amount_cents, frequency, category_id, account_id";
/** `id` is selected purely as the occurrence ordering tie-break. */
const OCCURRENCE_COLUMNS = "id, bill_id, due_date";

/** Ordering: `due_date ASC, name ASC, id ASC`. */
function byDueDate(a: Bill, b: Bill): number {
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Phase 6 Checkpoint 3: the next-scheduled-occurrence projection over
 * `public.bills` + `public.bill_occurrences`.
 *
 * `Bill.dueDate` is **not a stored column** — it is the earliest `scheduled`
 * occurrence's `due_date` (docs/database-schema.md §13). Two deterministic
 * queries, not an embedded resource:
 *
 *  1. the active bills, and
 *  2. every `scheduled` occurrence belonging to those bills, ordered
 *     `due_date ASC, id ASC`.
 *
 * PostgREST's embedded-resource `order`/`limit` applies to the *flattened*
 * join, not per parent row, so "the first occurrence of each bill" cannot be
 * expressed that way — a `limit` on the embed would truncate the whole result
 * set instead. The reduction to one occurrence per bill therefore happens in
 * TypeScript, over a single ordered result. Two queries total, whatever the
 * bill count: no N+1.
 *
 * Ordering of the returned list: `due_date ASC, name ASC, id ASC`. It is
 * applied here rather than in SQL for the same reason — the sort key is the
 * projected due date, which no single relation carries.
 */
export async function getBills(): Promise<Bill[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data: billData, error: billError } = await supabase
    .from("bills")
    .select(BILL_COLUMNS)
    .eq("user_id", ownerId)
    .eq("is_archived", false);

  // Checked before `data` is touched, and nothing partial is returned: a
  // failure of either query throws its own mapped error rather than
  // degrading into a half-populated list.
  if (billError) throw mapDbError(billError, "bills");

  const billRows = billData as BillRow[];
  // No active bills — the occurrence query would have an empty `IN` list and
  // could only return zero rows, so it is never issued.
  if (billRows.length === 0) return [];

  const { data: occurrenceData, error: occurrenceError } = await supabase
    .from("bill_occurrences")
    .select(OCCURRENCE_COLUMNS)
    .eq("user_id", ownerId)
    .eq("status", "scheduled")
    .in(
      "bill_id",
      billRows.map((row) => row.id)
    )
    .order("due_date", { ascending: true })
    .order("id", { ascending: true });

  if (occurrenceError) throw mapDbError(occurrenceError, "bill occurrences");

  // First row wins per bill: the result is already ordered `due_date ASC,
  // id ASC`, and only `scheduled` rows are in it, so a bill's paid/skipped
  // history can never displace its next scheduled due date.
  const nextDueDate = new Map<string, string>();
  for (const row of occurrenceData as BillOccurrenceRow[]) {
    if (!nextDueDate.has(row.bill_id)) nextDueDate.set(row.bill_id, row.due_date);
  }

  const bills: Bill[] = [];
  for (const row of billRows) {
    const dueDate = nextDueDate.get(row.id);
    // An active bill whose occurrences are all paid or skipped has no next
    // due date, and `Bill.dueDate` is required — there is no honest value to
    // invent for it, and a placeholder would land the bill in the overdue
    // group on /bills. Such a bill is omitted until an occurrence is
    // generated for it (docs/database-schema.md §13).
    if (dueDate === undefined) continue;
    bills.push(toBill(row, dueDate));
  }

  return bills.sort(byDueDate);
}

/**
 * Soonest due date first — an overdue bill sorts to the top. Deliberately
 * applies no `today` filter: "upcoming" here means "next in the queue", not
 * "due on or after today", and dropping overdue bills would hide exactly the
 * ones that need attention.
 *
 * Derived from `getBills()` rather than from its own `LIMIT`ed query,
 * because the sort key is the projected next-scheduled due date rather than
 * a column: the database cannot order — and therefore cannot correctly
 * truncate — this list.
 */
export async function getUpcomingBills(limit: number): Promise<Bill[]> {
  assertRowLimit(limit, "upcoming bills");
  return (await getBills()).slice(0, limit);
}
