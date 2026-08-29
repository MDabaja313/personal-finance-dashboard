import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { assertRowLimit } from "@/lib/data/filters";
import {
  calendarDateFrom,
  centsFrom,
  enumFrom,
  toBill,
  toBillOccurrence,
} from "@/lib/data/mappers";
import type {
  BillManagementRow,
  BillOccurrenceDetailRow,
  BillOccurrenceRow,
  BillRow,
} from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type {
  Bill,
  BillFrequency,
  BillOccurrence,
  CalendarDate,
  Cents,
} from "@/lib/types";
import { BILL_FREQUENCIES } from "@/lib/types/enums";

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

// ============================================================
// Phase 7 CP7 — the management read
// ============================================================

/** Every column `/bills`' management surface needs, including the two `getBills()` never selects. */
const BILL_MANAGEMENT_COLUMNS =
  "id, name, amount_cents, frequency, category_id, account_id, anchor_date, is_archived";

/** The full occurrence projection — everything on the `BillOccurrence` DTO. */
const OCCURRENCE_DETAIL_COLUMNS =
  "id, bill_id, due_date, status, amount_cents, transaction_id, paid_on";

/**
 * A recurring bill as the management surface needs it: the parent's own
 * editable terms, its archive state, its full occurrence history, and the next
 * scheduled due date derived from that history.
 *
 * Colocated here rather than widened onto the shared `Bill` DTO, exactly as
 * `GoalManagement` (CP6) and `Movement` (CP4) are. `Bill.dueDate` is a
 * *projection* — the next scheduled occurrence — and is required; a bill whose
 * occurrences are all paid or skipped has no honest value for it, which is
 * precisely the case a management view must still be able to show and fix.
 * `nextDueDate` here is therefore optional, and that difference is the reason
 * the two shapes are not one.
 *
 * `amountCents` is the parent's *current default* — what the next generated
 * occurrence will carry. It is never what a historical occurrence was due for;
 * that is each occurrence's own `amountCents` (docs/database-schema.md §13).
 */
export interface BillManagement {
  readonly id: string;
  readonly name: string;
  /** The parent's current default amount — not any occurrence's amount. */
  readonly amountCents: Cents;
  readonly frequency: BillFrequency;
  /** The recurrence anchor. Every due date derives from this, never from a clamped occurrence. */
  readonly anchorDate: CalendarDate;
  readonly categoryId?: string;
  readonly accountId?: string;
  readonly isArchived: boolean;
  /** The earliest `scheduled` occurrence, or absent when none remains. */
  readonly nextDueDate?: CalendarDate;
  /** Newest first: `due_date DESC, created_at DESC, id ASC`. */
  readonly occurrences: readonly BillOccurrence[];
}

/** Ordering of the returned list: `name ASC, id ASC`. */
function byName(a: BillManagement, b: BillManagement): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Every owned bill — active and archived alike — with its complete occurrence
 * history attached.
 *
 * **`getBills()`'s contract is untouched.** It still returns active bills
 * projected onto their earliest scheduled occurrence, and `/dashboard` still
 * depends on exactly that. This is a second, wider read for the one surface
 * that manages bills rather than displaying what is due.
 *
 * **Two queries, whatever the bill count — never N+1.** The bills, then every
 * occurrence belonging to them in one `IN` query, grouped in TypeScript. The
 * same shape `getBills()` uses and for the same reason: PostgREST's
 * embedded-resource `order`/`limit` applies to the flattened join rather than
 * per parent row, so "each bill's occurrences, ordered" cannot be expressed as
 * an embed.
 *
 * **Occurrence ordering is `due_date DESC, created_at DESC, id ASC`** — newest
 * obligation first, which is what a history list wants, with `created_at` as
 * the same-day tie-break every ordered read in this application uses and which
 * never appears on a DTO. `UNIQUE (bill_id, due_date)` means the tie-break can
 * only matter across bills, but it is applied anyway so the order is total
 * rather than incidentally stable.
 *
 * **`nextDueDate` is derived from that same result**, not from a third query:
 * the earliest `scheduled` occurrence, which is exactly what `getBills()`
 * resolves independently for the narrower DTO.
 *
 * The history is deliberately unbounded per bill, like `getGoalContributions()`
 * — a personal owner's bill has a handful of past occurrences and at most a
 * year of scheduled ones ahead of it (`public.maintain_bill_schedule`'s fixed
 * horizon). The dashboard never calls this.
 */
export async function getBillsForManagement(): Promise<BillManagement[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data: billData, error: billError } = await supabase
    .from("bills")
    .select(BILL_MANAGEMENT_COLUMNS)
    .eq("user_id", ownerId);

  if (billError) throw mapDbError(billError, "bills");

  const billRows = billData as BillManagementRow[];
  if (billRows.length === 0) return [];

  const { data: occurrenceData, error: occurrenceError } = await supabase
    .from("bill_occurrences")
    .select(OCCURRENCE_DETAIL_COLUMNS)
    .eq("user_id", ownerId)
    .in(
      "bill_id",
      billRows.map((row) => row.id)
    )
    .order("due_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (occurrenceError) throw mapDbError(occurrenceError, "bill occurrences");

  const byBill = new Map<string, BillOccurrence[]>();
  for (const row of occurrenceData as BillOccurrenceDetailRow[]) {
    const occurrence = toBillOccurrence(row);
    const bucket = byBill.get(occurrence.billId);
    if (bucket === undefined) byBill.set(occurrence.billId, [occurrence]);
    else bucket.push(occurrence);
  }

  const bills = billRows.map((row): BillManagement => {
    const occurrences = byBill.get(row.id) ?? [];

    // The list arrives newest-first, so the earliest scheduled occurrence is
    // the *last* scheduled one in it. Scanning rather than re-sorting keeps
    // one ordering contract for this function instead of two.
    let nextDueDate: CalendarDate | undefined;
    for (const occurrence of occurrences) {
      if (occurrence.status === "scheduled") nextDueDate = occurrence.dueDate;
    }

    return {
      id: row.id,
      name: row.name,
      amountCents: centsFrom(row.amount_cents, "bills.amount_cents"),
      frequency: enumFrom(row.frequency, BILL_FREQUENCIES, "bills.frequency"),
      anchorDate: calendarDateFrom(row.anchor_date, "bills.anchor_date"),
      categoryId: row.category_id ?? undefined,
      accountId: row.account_id ?? undefined,
      isArchived: row.is_archived,
      nextDueDate,
      occurrences,
    };
  });

  return bills.sort(byName);
}
