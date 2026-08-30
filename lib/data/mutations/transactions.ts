import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { refreshCurrentSnapshotAfter } from "@/lib/data/mutations/snapshots";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, invalidInput, notFound } from "@/lib/errors";
import type { Cents } from "@/lib/types";
import { categoryKindFor, type OrdinaryTransactionKind } from "@/lib/types/enums";
import type {
  TransactionCreateInput,
  TransactionUpdateInput,
} from "@/lib/validation/transactions";

/**
 * The write half of the transactions DAL — ordinary rows only.
 *
 * ## The rules this module keeps, unchanged from CP2
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()` and
 * uses what it returns. There is no `userId` argument to pass, so there is
 * nothing for a caller to get wrong: a Server Action is an independently
 * reachable endpoint that may never have rendered a guarded layout, so the
 * identity is re-established here, from the request's own verified claims, on
 * every single write.
 *
 * **Every statement carries an explicit owner predicate** on top of RLS.
 * `transactions_insert_own` / `transactions_update_own_ordinary` /
 * `transactions_delete_own_non_movement` are the enforced floor and stay that
 * way; the `.eq("user_id", ownerId)` on top is defense in depth, and it is what
 * makes a foreign id return "no rows" rather than depending solely on a policy
 * being correct.
 *
 * **No navigation, no revalidation.** Both are fenced out of
 * `lib/data/mutations/**` by ESLint, because both signal by throwing and the
 * action layer's `attempt()` catches everything.
 *
 * **Errors are typed, never raw.** Every failed response goes through
 * `mapWriteError`, which never quotes a PostgREST message — a write error's
 * payload is the worst one to quote, since it embeds the failing row.
 *
 * ## What this module deliberately cannot do
 *
 * **Movement legs are unreachable.** No function here accepts a `movementId`,
 * `createTransaction` writes an explicit `movement_id: null`, and the UPDATE
 * and DELETE policies make a leg invisible to both statements regardless. A
 * transfer or credit-card payment is a two-leg operation over a movement
 * parent; that is CP4, and it does not belong in a module about single rows.
 *
 * **Adjustments are unreachable.** The kind is typed
 * `OrdinaryTransactionKind`, so `adjustment` cannot be spelled here at all, and
 * the UPDATE policy refuses both to target an existing adjustment and to turn
 * an ordinary row into one. Reconciliation is CP5.
 *
 * ## Why the preflights exist
 *
 * Every function reads before it writes. That is not an authorization check —
 * RLS and the column-scoped GRANT are — it is an error-quality check. Without
 * it, entering a transaction against an account archived in another tab comes
 * back as SQLSTATE 23514 from `assert_transaction_refs()` and reaches the
 * person as "Some of the information entered is not valid", which is both wrong
 * and unactionable.
 *
 * The database guard is not thereby redundant, and must never be removed on the
 * strength of these checks: `authenticated` now holds direct INSERT, UPDATE and
 * DELETE privileges on this table, and PostgREST is reachable from a browser
 * with nothing but a session token. A rule enforced only here is enforced only
 * for callers who choose to come through here. It is also genuinely racy —
 * an account can be archived between the preflight and the write — which is
 * exactly the case the trigger catches and this layer cannot.
 */

/** The columns a read-back needs to compare a stored row against a payload. */
const OWN_ROW_COLUMNS = "id, user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents";

/** One stored transaction, normalized for comparison. Never returned to a caller. */
interface StoredTransaction {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly date: string;
  readonly merchant: string;
  readonly kind: string;
  readonly categoryId: string | null;
  readonly movementId: string | null;
  readonly amountCents: Cents;
}

/**
 * The owned transaction behind `transactionId`, or `undefined`.
 *
 * `undefined` rather than a throw, because both callers need to tell "no such
 * row" apart from a failure and each reports it differently. A foreign or
 * deleted id produces zero rows through RLS either way, so "someone else's
 * transaction" and "no such transaction" are deliberately indistinguishable —
 * telling them apart would confirm the existence of another owner's row.
 */
async function readOwnTransaction(transactionId: string): Promise<StoredTransaction | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("transactions")
    .select(OWN_ROW_COLUMNS)
    .eq("id", transactionId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  const rows = data as {
    id: string;
    user_id: string;
    account_id: string;
    date: string;
    merchant: string;
    kind: string;
    category_id: string | null;
    movement_id: string | null;
    amount_cents: number | string;
  }[];

  if (rows.length !== 1) return undefined;

  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    date: row.date,
    merchant: row.merchant,
    kind: row.kind,
    categoryId: row.category_id,
    movementId: row.movement_id,
    amountCents: centsFrom(row.amount_cents, "transactions.amount_cents"),
  };
}

/**
 * Refuses an account that does not exist, is not the caller's, or is archived.
 *
 * The archived rule is "unarchive it first", and it is not cosmetic: CP2's
 * `accounts_guard_update()` only permits archiving once an account's derived
 * balance is exactly zero, and `lib/finance/accounts.ts` excludes archived
 * accounts from net worth and from the asset/liability totals. Posting into one
 * would therefore create money that exists in the ledger and in no summary.
 */
async function assertAccountUsable(accountId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("accounts")
    .select("is_archived")
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  const rows = data as { is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That account does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That account is archived. Unarchive it before using it.");
  }
}

/**
 * Refuses a category that does not exist, is not the caller's, is archived, or
 * does not match the transaction's kind.
 *
 * Skipped entirely when no category was chosen — an uncategorized ordinary row
 * is legal and always has been.
 *
 * The kind rule is what keeps every rollup coherent: `kind` is what separates
 * income from spending in `spendingByCategory`, in budget utilisation, and in
 * the income/expense split, so an expense filed against an income category
 * would be counted in neither. A refund requires an *expense* category
 * deliberately — it reduces that category's spend rather than adding income.
 */
async function assertCategoryUsable(
  categoryId: string | undefined,
  kind: OrdinaryTransactionKind
): Promise<void> {
  if (categoryId === undefined) return;

  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("kind, is_archived")
    .eq("id", categoryId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  const rows = data as { kind: string; is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That category does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That category is archived. Unarchive it before using it.");
  }
  if (rows[0].kind !== categoryKindFor(kind)) {
    throw invalidInput("That category does not match the transaction type.");
  }
}

/** Both target preflights, run together — they are independent reads. */
async function assertTargetsUsable(
  accountId: string,
  categoryId: string | undefined,
  kind: OrdinaryTransactionKind
): Promise<void> {
  await Promise.all([assertAccountUsable(accountId), assertCategoryUsable(categoryId, kind)]);
}

/** The columns of one ordinary transaction row, as PostgREST takes them. */
interface TransactionPayload {
  readonly account_id: string;
  readonly date: string;
  readonly merchant: string;
  readonly kind: OrdinaryTransactionKind;
  readonly category_id: string | null;
  readonly amount_cents: number;
}

function payloadFor(input: TransactionCreateInput | TransactionUpdateInput): TransactionPayload {
  return {
    account_id: input.accountId,
    date: input.date,
    merchant: input.merchant,
    kind: input.kind,
    // Explicit `null` rather than an omitted key, so the row's shape does not
    // depend on which keys happened to be present in the input object.
    category_id: input.categoryId ?? null,
    amount_cents: input.amountCents,
  };
}

export interface TransactionCreateResult {
  readonly id: string;
  /**
   * True when the row was already there, byte-identical, under the same
   * idempotency key — a retry of a submission that had in fact succeeded.
   * The caller treats it as a success; nothing was written this time.
   */
  readonly deduplicated: boolean;
}

/**
 * Creates one ordinary transaction at the caller-supplied idempotency key.
 *
 * ## The idempotency contract, and why 23505 is not simply "fine"
 *
 * The form generates one UUID per logical submission and posts it as the row's
 * `id`, so a double-clicked or retried submit collides with itself on the
 * primary key rather than inserting a second row. That collision is the *only*
 * signal available: two coffees on the same day for the same amount are a
 * completely legitimate pair of rows, so nothing about the row's contents could
 * distinguish a duplicate from a genuine second purchase.
 *
 * Treating any 23505 as success would be wrong in two distinct ways, and both
 * are handled separately below:
 *
 * 1. **The key exists but the row differs.** The form was edited and
 *    resubmitted without a fresh key, or a request was replayed with altered
 *    fields. Reporting success would tell the person their edit was saved when
 *    the stored row still holds the original values. This is a `conflict`.
 * 2. **The key belongs to someone else.** RLS makes their row invisible, so the
 *    read-back finds nothing. Reporting success would confirm that a specific
 *    UUID exists in another owner's data — and would claim a write that never
 *    happened. This falls through as the ordinary unique conflict it is.
 *
 * Only an exact match on the *complete* normalized payload — owner, account,
 * date, merchant, kind, category (or its absence), `movement_id IS NULL`, and
 * the signed amount — counts as a successful retry. Comparing a subset would
 * make some edited resubmission silently indistinguishable from a retry, which
 * is the same bug as (1) with a smaller blast radius.
 *
 * There is no idempotency table and no middleware. The primary key already
 * enforces uniqueness, transactionally, with no second store to keep in step
 * and nothing to expire.
 */
export async function createTransaction(
  input: TransactionCreateInput
): Promise<TransactionCreateResult> {
  const ownerId = await getOwnerId();
  await assertTargetsUsable(input.accountId, input.categoryId, input.kind);

  const supabase = await getDataClient();

  const { error } = await supabase.from("transactions").insert({
    id: input.id,
    user_id: ownerId,
    ...payloadFor(input),
    // Written explicitly rather than omitted: this module creates ordinary
    // rows only, and saying so in the payload is what makes that visible at
    // the statement rather than inferable from the column list.
    movement_id: null,
  });

  if (error === null) {
    // A ledger row moves its account's derived balance, and therefore the
    // current month's assets or liabilities. Best-effort and after the write,
    // for the reasons `lib/data/mutations/snapshots.ts` sets out.
    await refreshCurrentSnapshotAfter("the transaction");
    return { id: input.id, deduplicated: false };
  }

  const mapped = mapWriteError(error, "the transaction");
  // Anything but a unique violation is a real failure — a check violation from
  // the trigger, a privilege problem, an unreachable database. Only 23505 is a
  // candidate for the idempotent-retry interpretation.
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnTransaction(input.id);
  // Case 2: the key is not ours. Fall through as the plain unique conflict.
  if (existing === undefined) throw mapped;

  if (!matchesPayload(existing, ownerId, input)) {
    // Case 1: our key, different row.
    throw conflict("A different transaction was already saved with that submission.");
  }

  // No refresh on the deduplicated path: nothing was written this time, so the
  // snapshot the refresh would recompute is the snapshot the *first* attempt
  // already produced.
  return { id: input.id, deduplicated: true };
}

/**
 * Whether a stored row is the exact row this input would have written.
 *
 * Field by field rather than by serializing both sides: a stringify comparison
 * would depend on key order and on how `undefined` versus `null` happened to
 * serialize, and both are exactly the distinctions that matter here.
 */
function matchesPayload(
  stored: StoredTransaction,
  ownerId: string,
  input: TransactionCreateInput
): boolean {
  return (
    stored.userId === ownerId &&
    stored.accountId === input.accountId &&
    stored.date === input.date &&
    stored.merchant === input.merchant &&
    stored.kind === input.kind &&
    stored.categoryId === (input.categoryId ?? null) &&
    stored.movementId === null &&
    stored.amountCents === input.amountCents
  );
}

/**
 * Updates one owned, ordinary transaction.
 *
 * `id`, `user_id`, `movement_id` and `created_at` are absent from the payload
 * *and* from the UPDATE grant, so none of them can move. The row itself is
 * re-read first, which does three things a bare UPDATE would not: it turns a
 * deleted or foreign id into a clean `not_found` rather than a silent zero-row
 * no-op, and it lets a movement leg and an adjustment be refused by name rather
 * than as "nothing happened".
 *
 * Both refusals are also enforced by `transactions_update_own_ordinary`'s
 * `USING` predicate, which makes those rows invisible to the statement
 * entirely. That is the stronger guarantee and the one that holds for a caller
 * bypassing this module; the checks here exist so the person gets a sentence
 * instead of a shrug.
 */
export async function updateTransaction(input: TransactionUpdateInput): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnTransaction(input.id);
  if (existing === undefined) throw notFound("That transaction does not exist.");
  if (existing.movementId !== null) {
    throw invalidInput("Transfers and card payments cannot be edited here.");
  }
  if (existing.kind === "adjustment") {
    throw invalidInput("A balance adjustment cannot be edited.");
  }

  await assertTargetsUsable(input.accountId, input.categoryId, input.kind);

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("transactions")
    .update(payloadFor(input))
    .eq("id", input.id)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  // An edit can change the amount, the date or the account — all three move a
  // snapshot figure, and the date can move it into or out of the current
  // month's as-of window.
  await refreshCurrentSnapshotAfter("the transaction");
}

/**
 * Deletes one owned, non-movement transaction.
 *
 * Transactions are deleted outright rather than archived, unlike accounts,
 * categories, bills and goals. Each of those is a *label* that historical rows
 * resolve through, so archiving keeps the past readable. A transaction is the
 * history: a mistyped one has no correct archived state, and a "voided" flag
 * would mean every balance, budget, KPI and chart growing a clause to exclude
 * it.
 *
 * Two things are refused before the statement runs:
 *
 * - **A movement leg.** Deleting one half of a transfer leaves the other
 *   stranded and the movement invalid. `transactions_delete_own_non_movement`
 *   makes legs invisible to DELETE regardless; removing a movement is a CP4
 *   operation on the *parent*, which cascades both legs.
 * - **A transaction a bill occurrence points at.** The FK
 *   `bill_occurrences (transaction_id, user_id) -> transactions` is
 *   `DEFERRABLE INITIALLY DEFERRED`, so without this preflight the refusal
 *   arrives at COMMIT as a bare 23503 with no indication of what to do. The
 *   remedy is a specific action — unmark that bill as paid — and it is worth a
 *   sentence. The deferred FK remains the backstop.
 *
 * An archived account's transactions are refused too, for the reason
 * `assertAccountUsable` documents: archiving requires a zero derived balance,
 * so removing a row from an archived account would leave money in an account
 * every total ignores. The database does not enforce this half — the DELETE
 * policy is deliberately about *rows*, not about account state — so this is one
 * of the few rules where the mutation layer is the only enforcement, and it is
 * recorded as such rather than implied.
 */
export async function deleteTransaction(transactionId: string): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnTransaction(transactionId);
  if (existing === undefined) throw notFound("That transaction does not exist.");
  if (existing.movementId !== null) {
    throw invalidInput("Transfers and card payments cannot be deleted here.");
  }

  await assertAccountUsable(existing.accountId);

  if (await isLinkedToBillOccurrence(transactionId)) {
    throw conflict("Unmark that bill as paid first.");
  }

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("transactions")
    .delete()
    .eq("id", transactionId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  await refreshCurrentSnapshotAfter("the transaction");
}

/**
 * Whether any owned bill occurrence records this transaction as its payment.
 *
 * `head: true` with an exact count asks PostgREST for the count and no rows, so
 * this stays O(1) on the wire. The owner predicate is applied on
 * `bill_occurrences` as well as on the transaction, so it can never count a row
 * it is not entitled to see.
 *
 * The relation is named as a literal rather than looped over a table list, so
 * `lib/write-posture.test.ts` can enumerate every relation this layer touches
 * by scanning the source — a dynamic `.from(table)` would read shorter and make
 * that check silently incomplete.
 */
async function isLinkedToBillOccurrence(transactionId: string): Promise<boolean> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { count, error } = await supabase
    .from("bill_occurrences")
    .select("id", { count: "exact", head: true })
    .eq("transaction_id", transactionId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transaction");

  return (count ?? 0) > 0;
}
