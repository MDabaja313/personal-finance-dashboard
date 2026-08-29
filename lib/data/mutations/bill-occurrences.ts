import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { calendarDateFrom, enumFrom } from "@/lib/data/mappers";
import { maintainBillScheduleAfter } from "@/lib/data/mutations/bill-schedule";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { invalidInput, notFound } from "@/lib/errors";
import type { BillOccurrenceStatus, CalendarDate } from "@/lib/types";
import { BILL_OCCURRENCE_STATUSES } from "@/lib/types/enums";
import type { BillOccurrencePaidInput } from "@/lib/validation/bill-occurrences";

/**
 * The write half of the bill-occurrence DAL — the status state machine, and
 * nothing else.
 *
 * ## Bill tracking creates no ledger activity. Ever.
 *
 * This is the load-bearing property of the whole checkpoint, so it is stated
 * as a rule rather than left as an observation: **no function in this module
 * writes, creates, edits or deletes a transaction, a movement, an account, a
 * budget or a snapshot.** Marking a bill paid records that an obligation was
 * met; it does not record that money moved, because the money moving is a
 * transaction the owner enters (or does not) entirely separately.
 *
 * The consequences are exact and are proved by
 * `tests/mutations/bill-occurrences.test.ts`: after any operation here, every
 * account balance, every income and spending total, cash flow, net worth and
 * the current month's net-worth snapshot are byte-for-byte unchanged. That is
 * also why `refreshCurrentSnapshotAfter` is not imported here and must never
 * be — there is no figure for it to recompute.
 *
 * ## Linking a transaction changes nothing about that transaction
 *
 * `transaction_id` is a reference and only a reference. It is not
 * recategorised, not re-dated, not re-amounted, not replaced, and not created:
 * the only column this module ever writes on any other table is
 * `bill_occurrences`' own. A bill's amount and its linked transaction's amount
 * are free to differ, because a bill is an expected obligation and a
 * transaction is what actually happened.
 *
 * The link *does* protect the transaction: `bill_occurrences_transaction_fk`
 * is `NO ACTION DEFERRABLE`, so a linked transaction cannot be deleted while
 * the occurrence still points at it. `lib/data/mutations/transactions.ts` and
 * `lib/data/mutations/movements.ts` both preflight that and say so
 * ("Unmark that bill as paid first.") rather than letting a deferred 23503
 * surface as a generic failure. Unmarking clears the reference and leaves the
 * transaction exactly where it was, deletable again under its ordinary rules.
 *
 * ## The rules this module keeps, unchanged from CP2–CP6
 *
 * **The owner is never a parameter** — `getOwnerId()` on every write.
 * **Every statement carries an explicit owner predicate** on top of
 * `bill_occurrences_update_own`. **No navigation, no revalidation.**
 * **Errors are typed, never raw.**
 *
 * ## What the grant makes impossible from here
 *
 * `authenticated` holds `UPDATE (status, transaction_id, paid_on)` and nothing
 * else on this table — no INSERT, no DELETE, and no privilege on `due_date`,
 * `amount_cents`, `bill_id`, `user_id`, `id` or `created_at`. So this module
 * cannot invent an occurrence, cannot remove one, and cannot rewrite what one
 * was due for or when. `guard_bill_occurrence_transition()` restates the
 * column half at the row level and adds the state machine: scheduled → paid,
 * scheduled → skipped, and either back to scheduled. A direct paid ↔ skipped
 * conversion is refused, so a correction goes through `scheduled` and is
 * visible as the two steps it is.
 *
 * ## Why every write is a full three-column assignment
 *
 * `bill_occurrences_status_consistency_ck` is a single-row CHECK: a scheduled
 * or skipped row must carry neither `paid_on` nor `transaction_id`, and a paid
 * row must carry `paid_on`. A partial update that moved `status` alone would
 * leave the row contradicting its own status and be refused. Writing all three
 * every time also makes each statement's intent complete on its face.
 */

/** The columns a preflight needs to produce a precise refusal. */
const OWN_ROW_COLUMNS = "id, user_id, bill_id, status, due_date";

/** One stored occurrence, normalized. Never returned to a caller. */
interface StoredOccurrence {
  readonly id: string;
  readonly billId: string;
  readonly status: BillOccurrenceStatus;
  readonly dueDate: CalendarDate;
}

/**
 * The owned occurrence behind `occurrenceId`, or `undefined`.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's occurrence" and "no such occurrence" are deliberately
 * indistinguishable to the caller.
 */
async function readOwnOccurrence(occurrenceId: string): Promise<StoredOccurrence | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("bill_occurrences")
    .select(OWN_ROW_COLUMNS)
    .eq("id", occurrenceId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill occurrence");

  const rows = data as {
    id: string;
    user_id: string;
    bill_id: string;
    status: string;
    due_date: string;
  }[];
  if (rows.length !== 1) return undefined;

  const row = rows[0];
  return {
    id: row.id,
    billId: row.bill_id,
    status: enumFrom(row.status, BILL_OCCURRENCE_STATUSES, "bill_occurrences.status"),
    dueDate: calendarDateFrom(row.due_date, "bill_occurrences.due_date"),
  };
}

/**
 * Refuses a transaction that does not exist or is not the caller's.
 *
 * `bill_occurrences_transaction_fk` is the structural same-owner backstop and
 * is `DEFERRABLE INITIALLY DEFERRED`, so a foreign or nonexistent reference
 * would otherwise fail at COMMIT as a 23503 with no useful sentence attached.
 * This is the message layer, not the enforcement.
 *
 * **No rule about the transaction's kind, amount, date or account.** The
 * approved design imposes none — inventing one here would refuse legitimate
 * records, and matching amounts is explicitly *not* how a payment is
 * identified.
 */
async function assertTransactionLinkable(transactionId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", transactionId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill occurrence");

  const rows = data as { id: string }[];
  if (rows.length !== 1) throw notFound("That transaction does not exist.");
}

/**
 * Applies one complete status assignment to an owned occurrence.
 *
 * All three writable columns, always — see the module note. The owner
 * predicate is on the statement as well as in the policy, and the update is
 * scoped by id, so a foreign id writes zero rows rather than depending on the
 * policy alone.
 */
async function writeStatus(
  occurrenceId: string,
  status: BillOccurrenceStatus,
  paidOn: CalendarDate | null,
  transactionId: string | null
): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { error } = await supabase
    .from("bill_occurrences")
    .update({ status, paid_on: paidOn, transaction_id: transactionId })
    .eq("id", occurrenceId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill occurrence");
}

/**
 * Marks one occurrence paid, optionally linking an existing owned transaction.
 *
 * ## Idempotency, without a key
 *
 * Unlike a create, this has nothing to duplicate: the row already exists and
 * the operation is an assignment, so submitting it twice produces the same
 * row. `guard_bill_occurrence_transition()` allows a paid → paid update
 * precisely so a double-clicked or retried mark-paid succeeds rather than
 * failing on a transition that never happened. The paid_on ceiling still
 * applies to the second one, as it must.
 *
 * A `skipped` occurrence is refused here rather than silently converted. The
 * database refuses it too (skipped → paid is not a supported transition); this
 * is the sentence that says why, and it names the two-step correction the
 * design intends: unskip first, then mark paid. Turning one into the other in
 * a single statement would clear and set payment fields as a side effect of a
 * status change nobody asked for.
 *
 * The schedule is topped up afterwards, best-effort and after the write has
 * committed — see `lib/data/mutations/bill-schedule.ts`. Marking a bill paid
 * is the thing an owner does as time passes, so it is the natural moment to
 * keep the rolling horizon rolling; it is not a reason the write can fail.
 */
export async function markBillOccurrencePaid(input: BillOccurrencePaidInput): Promise<void> {
  const existing = await readOwnOccurrence(input.id);
  if (existing === undefined) throw notFound("That bill occurrence does not exist.");

  if (existing.status === "skipped") {
    throw invalidInput("That occurrence is skipped. Unskip it before marking it paid.");
  }

  if (input.transactionId !== undefined) {
    await assertTransactionLinkable(input.transactionId);
  }

  await writeStatus(input.id, "paid", input.paidOn, input.transactionId ?? null);

  await maintainBillScheduleAfter(existing.billId, "the bill occurrence");
}

/**
 * Skips one occurrence — "this obligation did not apply this cycle".
 *
 * Creates no transaction and moves no money, exactly like marking one paid.
 * The occurrence keeps its own due date and amount, so the history still shows
 * what was skipped and what it would have cost; only `status` moves, and
 * `paid_on`/`transaction_id` are written as explicit nulls because
 * `bill_occurrences_status_consistency_ck` forbids either on a skipped row.
 *
 * A `paid` occurrence is refused, with the mirror of the message above: unmark
 * it first. Re-skipping an already-skipped occurrence is a no-op assignment
 * and succeeds, for the same idempotency reason mark-paid does.
 */
export async function skipBillOccurrence(occurrenceId: string): Promise<void> {
  const existing = await readOwnOccurrence(occurrenceId);
  if (existing === undefined) throw notFound("That bill occurrence does not exist.");

  if (existing.status === "paid") {
    throw invalidInput("That occurrence is marked paid. Unmark it before skipping it.");
  }

  await writeStatus(occurrenceId, "skipped", null, null);

  await maintainBillScheduleAfter(existing.billId, "the bill occurrence");
}

/**
 * Returns one paid or skipped occurrence to `scheduled` — the correction path
 * behind both "Unmark paid" and "Unskip".
 *
 * One function for two labels, because it is one transition. `paid_on` and
 * `transaction_id` are cleared in the same statement, which is not optional:
 * `bill_occurrences_status_consistency_ck` refuses a scheduled row that
 * carries either.
 *
 * **Clearing the link does not touch the linked transaction.** It stays
 * exactly where it was, with its own amount, category, account and date, and
 * becomes deletable again under its ordinary rules — which is precisely the
 * point of the "Unmark that bill as paid first." message the transaction and
 * movement delete paths carry.
 *
 * An already-scheduled occurrence is a no-op that reports success: the
 * person's request — "this should be scheduled" — is satisfied.
 */
export async function restoreBillOccurrence(occurrenceId: string): Promise<void> {
  const existing = await readOwnOccurrence(occurrenceId);
  if (existing === undefined) throw notFound("That bill occurrence does not exist.");

  if (existing.status === "scheduled") return;

  await writeStatus(occurrenceId, "scheduled", null, null);

  await maintainBillScheduleAfter(existing.billId, "the bill occurrence");
}
