import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { calendarDateFrom, enumFrom } from "@/lib/data/mappers";
import { maintainBillScheduleAfter } from "@/lib/data/mutations/bill-schedule";
import { refreshCurrentSnapshotAfter } from "@/lib/data/mutations/snapshots";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { invalidInput, notFound } from "@/lib/errors";
import type { BillOccurrenceStatus, CalendarDate } from "@/lib/types";
import { BILL_OCCURRENCE_STATUSES } from "@/lib/types/enums";
import type { BillOccurrencePaidInput } from "@/lib/validation/bill-occurrences";

/**
 * The write half of the bill-occurrence DAL — the status state machine, and
 * the one transition that may touch the ledger.
 *
 * ## What changed in Phase 8 CP1, and what did not
 *
 * Through CP7 this module's headline rule was "bill tracking creates no ledger
 * activity, ever". That was deliberate and it is now deliberately narrower.
 * The rule as it stands:
 *
 * - **A scheduled occurrence writes nothing.** An obligation that has not been
 *   met is a projection, and generating one creates no transaction, moves no
 *   balance, and appears in no economic total.
 * - **A skipped occurrence writes nothing.** Skipping says the obligation did
 *   not apply this cycle; nothing was paid, so nothing is recorded.
 * - **Creating, editing, archiving or unarchiving a bill writes nothing.** That
 *   is `lib/data/mutations/bills.ts`, and it still may not import the snapshot
 *   bridge at all.
 * - **Only `scheduled → paid` may write a ledger row**, and only through
 *   `public.settle_bill_occurrence`, and only when the owner did not link an
 *   existing transaction and the bill names an account that is not archived.
 * - **Only `paid → scheduled` may remove one**, and only the row the settlement
 *   itself generated.
 *
 * Everything else CP7 established is untouched: an occurrence's `amount_cents`
 * and `due_date` are absent from every grant and cannot be rewritten by anyone,
 * `bill_occurrences` still has no INSERT and no DELETE for `authenticated`, and
 * the four supported transitions are unchanged.
 *
 * ## Why settle and unsettle are RPCs, and skip is not
 *
 * A settlement is two writes that must be one commit: the occurrence becomes
 * paid *and* a transaction comes into existence. PostgREST issues one statement
 * per request in its own transaction, so two calls cannot do it — a failure
 * between them leaves either a paid occurrence with a phantom reference or an
 * orphan expense nothing points at. Its reversal is the same problem mirrored:
 * clearing the reference and deleting the row it referenced must not be
 * separable. So both are `SECURITY INVOKER` functions, running under the
 * caller's own privileges and RLS — the identical argument CP4's movement RPCs
 * and CP7's bill RPCs make.
 *
 * Skipping is genuinely one statement against one row and stays a plain
 * PostgREST update. Wrapping it in a function would add a privilege surface and
 * buy no guarantee.
 *
 * ## Provenance is a database fact, not an application claim
 *
 * `bill_occurrences.transaction_origin` distinguishes a row this application
 * generated from one the owner wrote and merely linked, and it is what decides
 * whether unmarking may delete anything. It is not trusted from the client and
 * is not decided here: `public.settle_bill_occurrence` sets it in SQL, and
 * `guard_bill_occurrence_transition()` accepts `'generated'` only for a
 * transaction whose `created_at` equals the current transaction's timestamp —
 * a column `authenticated` holds no grant on, in either direction. **A manually
 * linked transaction therefore cannot be relabelled as generated, and cannot be
 * deleted by any code path in this module.**
 *
 * ## The rules this module keeps, unchanged from CP2–CP7
 *
 * **The owner is never a parameter** — `getOwnerId()` on every write, and both
 * RPCs derive it from `auth.uid()` inside the database. **Every statement
 * carries an explicit owner predicate** on top of the policies. **No
 * navigation, no revalidation** — both fenced out of `lib/data/mutations/**` by
 * ESLint. **Errors are typed, never raw.**
 *
 * ## Why every plain write is a full four-column assignment
 *
 * `bill_occurrences_status_consistency_ck` is a single-row CHECK (a scheduled
 * or skipped row must carry neither `paid_on` nor `transaction_id`), and
 * `bill_occurrences_transaction_origin_ck` ties `transaction_origin` to
 * `transaction_id`. A partial update that moved `status` alone would leave the
 * row contradicting itself and be refused.
 */

/** The columns a preflight needs to produce a precise refusal. */
const OWN_ROW_COLUMNS = "id, user_id, bill_id, status, due_date";

/** The two RPCs this module may call, named once each. */
const SETTLE_RPC = "settle_bill_occurrence";
const UNSETTLE_RPC = "unsettle_bill_occurrence";

/** One stored occurrence, normalized. Never returned to a caller. */
interface StoredOccurrence {
  readonly id: string;
  readonly billId: string;
  readonly status: BillOccurrenceStatus;
  readonly dueDate: CalendarDate;
}

/**
 * The outcome of a settlement or its reversal, as the action layer needs it.
 *
 * `ledgerChanged` is the only field anything branches on, and it is the
 * database's answer rather than an inference: it is true exactly when a
 * transaction was created or removed. The action layer uses it to decide which
 * routes to revalidate and whether the current month's snapshot needs
 * recomputing — a link, an unlink, a skip and a status-only payment all move no
 * figure at all, and revalidating six routes for them would be noise.
 */
export interface BillOccurrenceWriteResult {
  readonly ledgerChanged: boolean;
  /**
   * True when nothing was written because the requested state was already
   * exactly what the database held — a retried or double-submitted mark-paid,
   * or an unmark of something already scheduled.
   */
  readonly deduplicated: boolean;
}

/** What `public.settle_bill_occurrence` returns. */
interface SettleRpcResult {
  settled: boolean;
  already_paid: boolean;
  ledger_changed: boolean;
  generated: boolean;
  category_applied: boolean;
  transaction_id: string | null;
}

/** What `public.unsettle_bill_occurrence` returns. */
interface UnsettleRpcResult {
  restored: boolean;
  ledger_changed: boolean;
  removed_transaction: boolean;
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
 * `public.settle_bill_occurrence` re-checks it in SQL, which is the actual
 * enforcement; this is the message layer.
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
 * Applies one complete status assignment to an owned occurrence, with no ledger
 * effect of any kind.
 *
 * The plain-PostgREST path, used only by `skipBillOccurrence`. All four
 * writable columns, always — see the module note. The owner predicate is on the
 * statement as well as in the policy, and the update is scoped by id, so a
 * foreign id writes zero rows rather than depending on the policy alone.
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
    .update({
      status,
      paid_on: paidOn,
      transaction_id: transactionId,
      // Written explicitly rather than omitted: this path never establishes a
      // payment reference, and saying so at the statement is what makes
      // `bill_occurrences_transaction_origin_ck` satisfied by construction
      // rather than by whatever the row happened to hold.
      transaction_origin: null,
    })
    .eq("id", occurrenceId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill occurrence");
}

/**
 * Marks one occurrence paid — linking an existing transaction, generating one,
 * or neither.
 *
 * ## Which of the three happens, and who decides
 *
 * `public.settle_bill_occurrence` decides, in SQL, from stored state:
 *
 * - `transactionId` supplied → **link** it. Nothing is created and nothing
 *   about that transaction is altered.
 * - otherwise, the bill names an account that is not archived → **generate**
 *   one ordinary expense: the *occurrence's own* amount (never the parent
 *   bill's current amount, which may have been repriced since), the bill's
 *   account, the bill's category when it can legally label an expense, dated
 *   `paidOn`, merchant taken from the bill's name, `movement_id` null.
 * - otherwise → **neither**. The occurrence is paid with no ledger row, exactly
 *   as every mark-paid behaved through CP7.
 *
 * The application layer does not re-derive that choice, and `/bills` states
 * which of the three a given Mark paid will produce *before* it is pressed
 * rather than reporting it afterwards.
 *
 * ## Idempotency, without a second store
 *
 * Three independent layers, and the first is the one that fires in practice:
 *
 * 1. **An already-paid occurrence is a no-op that reports success.** The RPC
 *    checks the status before it inserts anything, so a retry after a lost
 *    response, a double-clicked button and a replayed request all write nothing
 *    at all. It also means a *second* mark on a paid occurrence never creates a
 *    second transaction, whatever it carries — which is the whole of the
 *    duplicate-payment guarantee.
 * 2. **`generatedTransactionId` is a client-minted UUID** used verbatim as the
 *    new row's `id`, exactly as CP3/CP4/CP6/CP7 do it, so a torn retry that
 *    somehow reached the INSERT collides with itself on the primary key.
 * 3. **The settling UPDATE carries `status = 'scheduled'` in its own WHERE.**
 *    Two genuinely simultaneous requests cannot both succeed: the second blocks
 *    on the first's row lock, matches zero rows afterwards, and rolls its own
 *    inserted transaction back with it.
 *
 * A `skipped` occurrence is refused here rather than silently converted, with
 * the message CP7 established: the two-step correction is unskip, then mark
 * paid. The database refuses it too.
 *
 * The schedule is topped up afterwards, best-effort and after the write has
 * committed — see `lib/data/mutations/bill-schedule.ts`. So is the current
 * month's balance snapshot, and only when a ledger row actually moved.
 */
export async function markBillOccurrencePaid(
  input: BillOccurrencePaidInput
): Promise<BillOccurrenceWriteResult> {
  const existing = await readOwnOccurrence(input.id);
  if (existing === undefined) throw notFound("That bill occurrence does not exist.");

  if (existing.status === "skipped") {
    throw invalidInput("That occurrence is skipped. Unskip it before marking it paid.");
  }

  if (input.transactionId !== undefined) {
    await assertTransactionLinkable(input.transactionId);
  }

  const supabase = await getDataClient();

  const { data, error } = await supabase.rpc(SETTLE_RPC, {
    p_occurrence_id: input.id,
    p_paid_on: input.paidOn,
    // An absent link is posted as an explicit null rather than omitted: it is
    // the flag that selects the generate-or-nothing branch, and a missing key
    // would leave that to a default this module does not control.
    p_transaction_id: input.transactionId ?? null,
    p_generated_transaction_id: input.generatedTransactionId,
  });

  if (error) throw mapWriteError(error, "the bill occurrence");

  const result = data as SettleRpcResult | null;
  const ledgerChanged = result?.ledger_changed === true;

  if (ledgerChanged) {
    // A generated expense moves the bill account's derived balance and
    // therefore the current month's assets or liabilities. Best-effort and
    // after the write, for the reasons `lib/data/mutations/snapshots.ts` sets
    // out — never before, and never in a way that can fail the settlement.
    await refreshCurrentSnapshotAfter("the bill payment");
  }

  await maintainBillScheduleAfter(existing.billId, "the bill occurrence");

  return { ledgerChanged, deduplicated: result?.already_paid === true };
}

/**
 * Skips one occurrence — "this obligation did not apply this cycle".
 *
 * **Creates no transaction and moves no money.** That is not merely true today:
 * this function reaches neither RPC, writes only `bill_occurrences`, and
 * refreshes no snapshot, so there is no path from here to the ledger at all.
 *
 * The occurrence keeps its own due date and amount, so the history still shows
 * what was skipped and what it would have cost; only `status` moves, and the
 * three payment columns are written as explicit nulls because
 * `bill_occurrences_status_consistency_ck` and
 * `bill_occurrences_transaction_origin_ck` forbid any of them on a skipped row.
 *
 * A `paid` occurrence is refused, with the mirror of the mark-paid message:
 * unmark it first. That refusal is doing more work than it was in CP7 — an
 * unmark may now remove a generated transaction, and turning a paid occurrence
 * into a skipped one in a single statement would have to decide that reversal's
 * fate as a side effect of a status change nobody asked about.
 *
 * Re-skipping an already-skipped occurrence is a no-op assignment and succeeds.
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
 * One function for two labels, because it is one transition. `paid_on`,
 * `transaction_id` and `transaction_origin` are cleared in the same statement,
 * which is not optional: two CHECK constraints refuse a scheduled row that
 * carries any of them.
 *
 * ## What is reversed, and what is never touched
 *
 * The reversal is decided entirely by the occurrence's stored
 * `transaction_origin`, inside `public.unsettle_bill_occurrence`:
 *
 * - **`generated`** — the transaction was created by the settlement, in the
 *   same database transaction, and has never been anything else. It is deleted
 *   alongside the status change, so the ledger and the occurrence cannot end up
 *   disagreeing. Its account balance, the month's spending, and that category's
 *   budget utilisation all return to where they were.
 * - **`linked`** — the owner's own transaction. The reference is cleared and
 *   **the row is never deleted, under any circumstance.** It keeps its amount,
 *   category, account and date, and becomes deletable again under its ordinary
 *   rules — which is precisely the point of the "Unmark that bill as paid
 *   first." message the transaction and movement delete paths carry.
 * - **neither** — a status-only payment or a skipped occurrence. Only the
 *   status moves.
 *
 * The two cases are not told apart by inspecting the transaction, by comparing
 * amounts, or by anything this layer computes. They are told apart by a stored
 * enum the database refuses to let a caller forge.
 *
 * An already-scheduled occurrence is a no-op that reports success: the person's
 * request — "this should be scheduled" — is satisfied, and nothing is deleted.
 */
export async function restoreBillOccurrence(
  occurrenceId: string
): Promise<BillOccurrenceWriteResult> {
  const existing = await readOwnOccurrence(occurrenceId);
  if (existing === undefined) throw notFound("That bill occurrence does not exist.");

  if (existing.status === "scheduled") {
    return { ledgerChanged: false, deduplicated: true };
  }

  const supabase = await getDataClient();

  const { data, error } = await supabase.rpc(UNSETTLE_RPC, { p_occurrence_id: occurrenceId });

  if (error) throw mapWriteError(error, "the bill occurrence");

  const result = data as UnsettleRpcResult | null;
  const ledgerChanged = result?.ledger_changed === true;

  if (ledgerChanged) {
    await refreshCurrentSnapshotAfter("the bill payment");
  }

  await maintainBillScheduleAfter(existing.billId, "the bill occurrence");

  return { ledgerChanged, deduplicated: result?.restored !== true };
}
