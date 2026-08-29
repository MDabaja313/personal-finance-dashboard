import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { refreshCurrentSnapshotAfter } from "@/lib/data/mutations/snapshots";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { dataIntegrity, invalidInput, notFound } from "@/lib/errors";
import type { AccountType, Cents } from "@/lib/types";
import { isLiabilityAccountType } from "@/lib/types/enums";
import type { ReconcileInput } from "@/lib/validation/reconciliation";

/**
 * The reconciliation half of the mutation DAL — the only path that can write
 * an `adjustment`, and the only path that can remove one.
 *
 * ## What reconciliation is, and what it deliberately is not
 *
 * A person states what an account's balance actually is. The database computes
 *
 *     delta = desired internal balance - (opening_balance + SUM(ledger))
 *
 * and writes one `adjustment` row for exactly that delta, dated as of the day
 * the observation was true. It **never rewrites history**: no existing
 * transaction is touched, no amount is restated, and `opening_balance_cents`
 * is not the mechanism — editing that would silently restate every balance the
 * account has ever reported, including ones already written into
 * `net_worth_snapshots`, which is precisely why CP2's `accounts_guard_update()`
 * freezes it the moment the account has any transaction at all.
 *
 * The adjustment moves the account's balance and net worth and appears in no
 * economic total: `countsAsSpending` and `countsAsIncome`
 * (`lib/finance/transactions.ts`) are allowlists of `expense`/`refund` and
 * `income` respectively, so an adjustment is excluded **by kind** — not by
 * sign, and not by happening to carry no category.
 *
 * ## An adjustment is not editable, and correcting one means removing it
 *
 * `transactions_update_own_ordinary` carries `kind <> 'adjustment'` in both
 * its `USING` and its `WITH CHECK`, so an existing adjustment cannot be
 * targeted by an UPDATE and an ordinary row cannot be turned into one. That is
 * deliberate: an adjustment is the ledger's record of a decision made against
 * a balance at a moment in time, and editing its amount would restate that
 * decision without the observation that justified it.
 *
 * So the lifecycle is delete-and-reconcile-again, and `deleteAdjustment` below
 * is the specific path for it. It is *not* a widening of the ordinary delete
 * surface: it reuses the same `DELETE` grant and the same
 * `transactions_delete_own_non_movement` policy CP3 already established (which
 * deliberately did **not** exclude adjustments, precisely so CP5 could do
 * this), and it refuses by name anything that is not an owned, non-movement
 * adjustment.
 *
 * ## The rules this module keeps, unchanged from CP2–CP4
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()`, and
 * `public.reconcile_account` takes no owner either — it derives one from
 * `auth.uid()` inside the database.
 *
 * **Every statement carries an explicit owner predicate** on top of RLS.
 *
 * **No navigation, no revalidation** — both fenced out by ESLint.
 *
 * **Errors are typed, never raw** — every failure goes through
 * `mapWriteError`, which never quotes a PostgREST message.
 *
 * ## Why the delta is computed in SQL and not here
 *
 * It would be one subtraction, and doing it here would be wrong. The current
 * balance would have to be read in one request and the resulting delta posted
 * in another, so a transaction entered in between — in another tab, on a
 * phone — would leave the account reconciled to a figure that was correct
 * when the balance was read and is wrong by the time the row lands. The
 * adjustment would look perfectly well-formed and simply be wrong.
 * `public.reconcile_account` derives the balance in the same statement that
 * writes the row, which removes that window entirely.
 */

/** What the reconcile surface needs to know about an account before it asks. */
export interface ReconcileTarget {
  readonly type: AccountType;
  readonly balanceCents: Cents;
  readonly isArchived: boolean;
}

/**
 * The owned account behind `accountId`, read through `account_balances`
 * because the derived balance lives only there.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's account" and "no such account" are deliberately
 * indistinguishable — telling them apart would confirm the existence of
 * another owner's row.
 */
async function readReconcileTarget(accountId: string): Promise<ReconcileTarget> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("account_balances")
    .select("type, balance_cents, is_archived")
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the reconciliation");

  const rows = data as { type: string; balance_cents: number | string; is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That account does not exist.");

  return {
    type: rows[0].type as AccountType,
    balanceCents: centsFrom(rows[0].balance_cents, "account_balances.balance_cents"),
    isArchived: rows[0].is_archived,
  };
}

/**
 * The account's stored type, for the caller to parameterize
 * `makeReconcileSchema()` with.
 *
 * Exported separately for the same reason `getAccountTypeForUpdate` is: the
 * type has to be known *before* the form input can be validated, because it
 * decides whether a minus sign is acceptable — a liability is reconciled
 * against a non-negative "amount owed", an asset against its signed actual
 * balance. Reading it here rather than accepting it from the submission is
 * what stops a hand-crafted request choosing which convention applies to it,
 * and this read also turns a deleted or foreign id into a clean "no longer
 * exists" before anything else runs.
 */
export async function getAccountTypeForReconciliation(accountId: string): Promise<AccountType> {
  return (await readReconcileTarget(accountId)).type;
}

/** The result of one reconciliation, as the action reports it. */
export interface ReconcileResult {
  /** False when the derived balance already matched — a success that wrote nothing. */
  readonly created: boolean;
  /** The adjustment's row id, when one was written. */
  readonly adjustmentId: string | undefined;
  /** The signed correction that was applied. Exactly `0` when nothing was written. */
  readonly deltaCents: Cents;
}

/** The RPC's return shape, before it is narrowed into a `ReconcileResult`. */
interface ReconcileRpcResult {
  created: unknown;
  adjustment_id: unknown;
  delta_cents: unknown;
}

/**
 * Reconciles one owned, active account to an observed balance.
 *
 * ## Liability normalization happens here, from the stored type
 *
 * `input.observedCents` is whatever the person typed under their form's own
 * convention. The account's type is re-read *from the database* — never taken
 * from the caller, and never trusted from the action's earlier read — and a
 * `credit` or `loan` account's non-negative "amount owed" is negated into the
 * internal balance the schema actually stores. $0 owed is internal `0`; $500
 * owed is internal `-50000`.
 *
 * The negation lives here rather than in SQL on purpose. Inside
 * `public.reconcile_account` the parameter has exactly one meaning — the
 * desired internal signed balance — which is the only meaning a database
 * boundary should have. A parameter whose interpretation flipped based on a
 * row it looked up would be a parameter no caller could reason about, and an
 * overpaid credit card (a genuinely positive balance on a `credit` account) is
 * a legal state that such a rule would make unreachable.
 *
 * ## What is checked here, and what is left to the database
 *
 * The preflights below are error-quality checks, not authorization: the RPC
 * re-checks ownership and the archived flag in SQL, `assert_transaction_refs()`
 * enforces the posted-date ceiling against the owner's own calendar day, and
 * the two adjustment CHECK constraints refuse a category or a movement id
 * regardless. What they buy is a sentence a person can act on instead of a
 * trigger's check violation.
 *
 * ## Idempotency, without a key
 *
 * A resubmission computes its delta against a balance the first submission
 * already corrected, so the delta is zero and no row is written. That is why
 * this operation needs no client-minted UUID, unlike CP3's and CP4's creates:
 * a second identical reconciliation is not a second event, it is the same
 * observation restated.
 */
export async function reconcileAccount(input: ReconcileInput): Promise<ReconcileResult> {
  const target = await readReconcileTarget(input.accountId);

  if (target.isArchived) {
    throw invalidInput("That account is archived. Unarchive it before reconciling it.");
  }

  const desiredBalanceCents = isLiabilityAccountType(target.type)
    ? -input.observedCents || 0 // `|| 0` normalizes -0, which stringifies as "-0"
    : input.observedCents;

  const supabase = await getDataClient();

  const { data, error } = await supabase.rpc("reconcile_account", {
    p_account_id: input.accountId,
    p_as_of: input.asOf,
    p_desired_balance_cents: desiredBalanceCents,
  });

  if (error) throw mapWriteError(error, "the reconciliation");

  const result = narrowRpcResult(data);

  // Only when a row was actually written. A zero-delta reconciliation changed
  // no balance, so the snapshot it would recompute is the snapshot that is
  // already there.
  if (result.created) await refreshCurrentSnapshotAfter("the reconciliation");

  return result;
}

/**
 * Narrows the RPC's `jsonb` into a `ReconcileResult`.
 *
 * Field by field, with `centsFrom` applied to the delta like every other money
 * value crossing the DB→TS boundary — a `bigint` reaching JSON as a number can
 * exceed the safe-integer range, and silently accepting one would put an
 * imprecise figure into a domain that guarantees exact cents. A response that
 * does not match the shape is `data_integrity`: it means the function and this
 * module have diverged, which is a server fault and not something a person
 * did.
 */
function narrowRpcResult(data: unknown): ReconcileResult {
  if (typeof data !== "object" || data === null) {
    throw dataIntegrity("The reconciliation returned an unusable result.");
  }

  const row = data as ReconcileRpcResult;

  if (typeof row.created !== "boolean") {
    throw dataIntegrity("The reconciliation returned an unusable result.");
  }

  const deltaCents = centsFrom(
    row.delta_cents as number | string,
    "reconcile_account.delta_cents"
  );

  if (row.created) {
    if (typeof row.adjustment_id !== "string") {
      throw dataIntegrity("The reconciliation returned an unusable result.");
    }
    return { created: true, adjustmentId: row.adjustment_id, deltaCents };
  }

  return { created: false, adjustmentId: undefined, deltaCents };
}

/** One stored transaction, as the delete preflight needs to see it. */
interface StoredAdjustment {
  readonly accountId: string;
  readonly kind: string;
  readonly movementId: string | null;
}

/**
 * Removes one owned adjustment, so a bad reconciliation can be undone and
 * re-run.
 *
 * This is deliberately a reconciliation-specific path rather than a widening
 * of anything. It adds **no privilege**: the `DELETE` grant on `transactions`
 * and `transactions_delete_own_non_movement` are both exactly as CP3 left
 * them, and that policy already permitted an adjustment (it carries
 * `movement_id IS NULL` and nothing about kind) for precisely this reason.
 * What this function adds is the refusal in the other direction — it will not
 * delete anything that is *not* an adjustment, so it can never become a second
 * route to removing an ordinary transaction or a movement leg.
 *
 * Three refusals before the statement runs:
 *
 * - **Not an adjustment.** Ordinary rows are removed through
 *   `deleteTransaction`, which has its own bill-occurrence and archived-account
 *   rules; a movement leg is removed by deleting its parent. Neither belongs
 *   here.
 * - **A movement leg.** Redundant with the `kind` check (an adjustment never
 *   carries a movement id — `transactions_movement_biconditional_ck`) and
 *   stated anyway, because "this path cannot touch a leg" should be true by
 *   inspection rather than by a chain of two constraints.
 * - **An archived account.** The same single-layer rule `deleteTransaction`
 *   and `deleteMovement` carry: archiving requires a derived balance of exactly
 *   zero, so removing a row from an archived account would leave money in an
 *   account every total ignores. The database does not enforce this half — the
 *   `DELETE` policy is about *rows*, not account state — so it is recorded here
 *   rather than implied.
 *
 * No bill-occurrence check: `bill_occurrences.transaction_id` points at the
 * row that *paid* a bill, and an adjustment never pays one — it is not a
 * payment, and nothing in the application can mark it as one.
 */
export async function deleteAdjustment(adjustmentId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("transactions")
    .select("account_id, kind, movement_id")
    .eq("id", adjustmentId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the adjustment");

  const rows = data as { account_id: string; kind: string; movement_id: string | null }[];
  if (rows.length !== 1) throw notFound("That adjustment does not exist.");

  const existing: StoredAdjustment = {
    accountId: rows[0].account_id,
    kind: rows[0].kind,
    movementId: rows[0].movement_id,
  };

  if (existing.kind !== "adjustment" || existing.movementId !== null) {
    throw invalidInput("Only a balance adjustment can be removed here.");
  }

  const target = await readReconcileTarget(existing.accountId);
  if (target.isArchived) {
    throw invalidInput("That account is archived. Unarchive it before changing its history.");
  }

  const { error: deleteError } = await supabase
    .from("transactions")
    .delete()
    .eq("id", adjustmentId)
    .eq("user_id", ownerId);

  if (deleteError) throw mapWriteError(deleteError, "the adjustment");

  await refreshCurrentSnapshotAfter("the adjustment");
}
