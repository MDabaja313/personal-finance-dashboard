import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { calendarDateFrom, centsFrom, enumFrom } from "@/lib/data/mappers";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, invalidInput, notFound } from "@/lib/errors";
import type { BillFrequency, CalendarDate, Cents } from "@/lib/types";
import { BILL_FREQUENCIES } from "@/lib/types/enums";
import type { BillInput } from "@/lib/validation/bills";

/**
 * The write half of the bills DAL — recurring bills and their schedules.
 *
 * ## The rules this module keeps, unchanged from CP2–CP6
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()` and
 * uses what it returns, and the three RPCs it invokes take no owner either —
 * they derive it from `auth.uid()` inside the database, and the scheduler they
 * call derives it from the request's own JWT claim. There is no `userId`
 * argument anywhere on this path.
 *
 * **Every statement carries an explicit owner predicate** on top of RLS.
 * `bills_insert_own` / `bills_update_own` are the enforced floor; the
 * `.eq("user_id", ownerId)` on top is defense in depth, and the RPCs re-apply
 * the same predicate in SQL.
 *
 * **No navigation, no revalidation.** Both are fenced out of
 * `lib/data/mutations/**` by ESLint.
 *
 * **Errors are typed, never raw.** Every failed response goes through
 * `mapWriteError`, which never quotes a PostgREST message.
 *
 * ## Why all three operations are RPCs
 *
 * A recurring bill is a parent plus a *derived rolling schedule*, and the two
 * are only ever correct together:
 *
 * - **Create.** A bill with no occurrence has no projected due date, so
 *   `getBills()` omits it entirely — it is invisible on `/bills` and on the
 *   dashboard, which reads exactly like the create having failed. The INSERT
 *   and the first generation therefore commit together, inside
 *   `public.create_bill`.
 * - **Edit.** Changing the amount, frequency or anchor date invalidates every
 *   *future scheduled* occurrence and no past one. `public.replace_bill`
 *   deletes and regenerates them in the same transaction as the UPDATE, so a
 *   refused regeneration rolls the edit back with it and the old bill *and*
 *   its old schedule survive byte for byte.
 * - **Archive.** Unarchiving has to restore a usable horizon; doing that in a
 *   second request would leave an unarchived bill with no next occurrence if
 *   that request failed.
 *
 * PostgREST issues one statement per request, each in its own transaction, so
 * none of those three is expressible as a sequence of PostgREST calls. All
 * three RPCs are `SECURITY INVOKER` — the caller already holds every privilege
 * their bodies use — and the one `SECURITY DEFINER` step they reach,
 * `public.maintain_bill_schedule`, exists because `bill_occurrences` has no
 * INSERT or DELETE grant for `authenticated` and never will.
 *
 * ## What this module deliberately cannot do
 *
 * **It cannot delete a bill.** There is no DELETE grant on `bills` and there
 * will not be one: docs/database-schema.md §5's rule is soft-delete only, and
 * `bill_occurrences`' composite FK back to `bills` is `NO ACTION DEFERRABLE`
 * rather than `CASCADE`, so a hard delete of a bill with any occurrence would
 * fail at COMMIT anyway. `setBillArchived` is the whole removal surface.
 *
 * **It cannot write an occurrence.** No function here names
 * `bill_occurrences` in a write at all. Generation is the scheduler's; status
 * changes are `lib/data/mutations/bill-occurrences.ts`'.
 *
 * **It writes no transaction and no snapshot.** Bill tracking creates no
 * ledger activity, so no balance, no total and no net-worth figure can move —
 * which is why `refreshCurrentSnapshotAfter` is not imported here and must
 * never be.
 *
 * ## Why the preflights exist
 *
 * Every function reads before it writes. That is not an authorization check —
 * RLS, the column-scoped GRANT and the RPCs' own checks are — it is an
 * error-quality check, and on create it is load-bearing for a second reason:
 * the read-back is how an idempotent retry is told apart from a conflicting
 * resubmission.
 */

/** The columns a read-back needs to compare a stored bill against a payload. */
const OWN_ROW_COLUMNS =
  "id, user_id, name, amount_cents, frequency, anchor_date, category_id, account_id, is_archived";

/** One stored bill, normalized for comparison. Never returned to a caller. */
interface StoredBill {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly amountCents: Cents;
  readonly frequency: BillFrequency;
  readonly anchorDate: CalendarDate;
  readonly categoryId?: string;
  readonly accountId?: string;
  readonly isArchived: boolean;
}

interface OwnBillRow {
  id: string;
  user_id: string;
  name: string;
  amount_cents: number | string;
  frequency: string;
  anchor_date: string;
  category_id: string | null;
  account_id: string | null;
  is_archived: boolean;
}

/**
 * The owned bill behind `billId`, or `undefined`.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's bill" and "no such bill" are deliberately indistinguishable
 * to the caller.
 */
async function readOwnBill(billId: string): Promise<StoredBill | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("bills")
    .select(OWN_ROW_COLUMNS)
    .eq("id", billId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill");

  const rows = data as OwnBillRow[];
  if (rows.length !== 1) return undefined;

  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    amountCents: centsFrom(row.amount_cents, "bills.amount_cents"),
    frequency: enumFrom(row.frequency, BILL_FREQUENCIES, "bills.frequency"),
    anchorDate: calendarDateFrom(row.anchor_date, "bills.anchor_date"),
    categoryId: row.category_id ?? undefined,
    accountId: row.account_id ?? undefined,
    isArchived: row.is_archived,
  };
}

/**
 * Refuses a category that does not exist, is not the caller's, or is archived.
 *
 * The rule and its rationale are `assert_bill_refs()`'s, which is the actual
 * enforcement — this is the layer that turns a trigger's check violation into
 * a sentence naming which rule was broken. An archived category still resolves
 * the label on every historical row that references it, so the remedy is
 * "unarchive it or pick another", not "the data is corrupt".
 *
 * **The category's `kind` is deliberately not checked.** No approved pre-CP7
 * requirement says a bill's category must be an expense category:
 * `bills.category_id` is a plain nullable composite FK with no CHECK, and no
 * document states a kind rule for it. CP6's budgets rule does not transfer —
 * for a budget, "expense" is what the row means; for a bill the category is a
 * label on a recurring obligation. Enforcing it here would be inventing a rule
 * the rest of the application does not have.
 */
async function assertCategoryUsable(categoryId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("is_archived")
    .eq("id", categoryId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill");

  const rows = data as { is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That category does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That category is archived. Unarchive it or choose another.");
  }
}

/**
 * Refuses an account that does not exist, is not the caller's, or is archived.
 *
 * The same rule an ordinary transaction and a movement leg get, for the same
 * reason: archiving requires a derived balance of exactly zero
 * (`accounts_guard_update()`), and `lib/finance/accounts.ts` excludes archived
 * accounts from net worth — so pointing a live recurring obligation at one
 * would name an account no summary includes.
 */
async function assertAccountUsable(accountId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("accounts")
    .select("is_archived")
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the bill");

  const rows = data as { is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That account does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That account is archived. Unarchive it before using it.");
  }
}

/** Both optional-reference preflights, run together — they are independent reads. */
async function assertReferencesUsable(input: BillInput): Promise<void> {
  await Promise.all([
    input.categoryId === undefined ? Promise.resolve() : assertCategoryUsable(input.categoryId),
    input.accountId === undefined ? Promise.resolve() : assertAccountUsable(input.accountId),
  ]);
}

/**
 * The RPC argument object, built once so create and replace cannot drift.
 *
 * An absent optional reference is posted as an explicit `null`, not omitted:
 * clearing a bill's category or account has to be expressible, and a missing
 * key would leave the stored value in place on an edit.
 */
function rpcArgs(input: BillInput) {
  return {
    p_bill_id: input.id,
    p_name: input.name,
    p_amount_cents: input.amountCents,
    p_frequency: input.frequency,
    p_anchor_date: input.anchorDate,
    p_category_id: input.categoryId ?? null,
    p_account_id: input.accountId ?? null,
  };
}

/**
 * Whether a stored bill is exactly the bill this input would have written.
 *
 * Field by field rather than by serializing both sides, for the reason
 * `matchesPayload` in the movement module gives: a stringify comparison would
 * depend on key order and on how `undefined` versus `null` happened to
 * serialize. Every editable field is compared — comparing a subset would make
 * some edited resubmission silently indistinguishable from a retry, which is
 * the exact failure this mechanism exists to prevent.
 *
 * `isArchived` is deliberately absent: a bill is never *created* archived (the
 * INSERT inside `public.create_bill` does not name the column, so it takes its
 * `false` default), so a stored archived bill under the caller's key cannot be
 * this submission's own retry regardless of what else matches.
 */
function matchesPayload(stored: StoredBill, input: BillInput): boolean {
  return (
    stored.id === input.id &&
    stored.name === input.name &&
    stored.amountCents === input.amountCents &&
    stored.frequency === input.frequency &&
    stored.anchorDate === input.anchorDate &&
    (stored.categoryId ?? null) === (input.categoryId ?? null) &&
    (stored.accountId ?? null) === (input.accountId ?? null) &&
    !stored.isArchived
  );
}

export interface BillWriteResult {
  readonly id: string;
  /**
   * True when nothing was written this time because the requested state was
   * already exactly what the database held — an identical retry under the same
   * idempotency key.
   */
  readonly deduplicated: boolean;
  /**
   * True when the future schedule was rebuilt from new recurrence terms.
   *
   * Always `false` on create (there is nothing to rebuild) and on a
   * metadata-only edit. The RPC decides it from the stored row, not the
   * caller: a client-computed "did the terms change" answer would be deciding
   * whether occurrences get deleted.
   */
  readonly rebuilt: boolean;
}

interface BillRpcResult {
  id: string;
  rebuilt: boolean;
  generated: number;
}

/**
 * Creates one bill and its first schedule, atomically.
 *
 * ## The idempotency contract, and why 23505 is not simply "fine"
 *
 * The form mints one bill UUID when it mounts and keeps it until the
 * submission logically succeeds, so a double-clicked or retried submit
 * collides with itself on the primary key rather than creating a second
 * recurring obligation — which would then generate a second full year of
 * occurrences and double every projection the dashboard shows. That collision
 * is the only signal available: two bills with the same name, amount and
 * frequency are a completely legitimate pair.
 *
 * Treating any 23505 as success would be wrong in two distinct ways, handled
 * separately below:
 *
 * 1. **The key exists but the bill differs.** The form was edited and
 *    resubmitted without a fresh key. Reporting success would tell the person
 *    their change was saved when the stored bill still holds the original
 *    terms — and the generated schedule would match neither. This is a
 *    `conflict`.
 * 2. **The key belongs to someone else.** RLS makes their bill invisible, so
 *    the read-back finds nothing. Reporting success would confirm that a
 *    specific UUID exists in another owner's data, and would claim a write
 *    that never happened. This falls through as the ordinary unique conflict
 *    it is.
 *
 * There is no idempotency table and no middleware.
 */
export async function createBill(input: BillInput): Promise<BillWriteResult> {
  await assertReferencesUsable(input);

  const supabase = await getDataClient();

  const { error } = await supabase.rpc("create_bill", rpcArgs(input));

  if (error === null) return { id: input.id, deduplicated: false, rebuilt: false };

  const mapped = mapWriteError(error, "the bill");
  // Anything but a unique violation is a real failure — a check violation from
  // assert_bill_refs(), a privilege problem, an unreachable database. Only
  // 23505 is a candidate for the idempotent-retry interpretation.
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnBill(input.id);
  // Case 2: the key is not ours. Fall through as the plain unique conflict.
  if (existing === undefined) throw mapped;

  if (!matchesPayload(existing, input)) {
    // Case 1: our key, different bill.
    throw conflict("A different bill was already saved with that submission.");
  }

  return { id: input.id, deduplicated: true, rebuilt: false };
}

/**
 * Edits one owned bill, rebuilding its future schedule when the recurrence
 * terms changed.
 *
 * The preflight refuses an archived bill with its own sentence rather than
 * letting `public.replace_bill`'s check violation surface as a generic
 * "invalid input". Editing an archived bill is refused because its schedule
 * cannot be regenerated while archived, so the terms and the occurrences would
 * disagree until some later unarchive.
 *
 * What the rebuild preserves is decided in SQL and is worth restating here,
 * because it is the whole reason an edit is safe: every paid occurrence, every
 * skipped occurrence, and every scheduled occurrence already due *before* the
 * owner's today are untouched. Only scheduled occurrences due today or later
 * are replaced, and the new ones carry the bill's new default amount. A
 * historical occurrence's `amount_cents` was fixed when it was generated and
 * nothing in this path can rewrite it.
 */
export async function updateBill(input: BillInput): Promise<BillWriteResult> {
  const existing = await readOwnBill(input.id);
  if (existing === undefined) throw notFound("That bill does not exist.");
  if (existing.isArchived) {
    throw invalidInput("That bill is archived. Unarchive it before editing it.");
  }

  await assertReferencesUsable(input);

  const supabase = await getDataClient();

  const { data, error } = await supabase.rpc("replace_bill", rpcArgs(input));

  if (error) throw mapWriteError(error, "the bill");

  const result = data as BillRpcResult | null;

  return { id: input.id, deduplicated: false, rebuilt: result?.rebuilt === true };
}

/**
 * Archives or unarchives one owned bill.
 *
 * Unconditional in both directions, and neither direction touches a single
 * occurrence's status, amount or due date. Archiving keeps the whole history
 * (docs/database-schema.md §5) and simply removes the bill from `getBills()`'s
 * active projection, so it stops appearing on `/bills` as active and on the
 * dashboard's upcoming list. Unarchiving restores a usable horizon in the same
 * transaction — generation resumes from the owner's today rather than
 * back-filling the archived gap, because nobody owed anything on a bill they
 * had stopped tracking.
 */
export async function setBillArchived(billId: string, archived: boolean): Promise<void> {
  const existing = await readOwnBill(billId);
  if (existing === undefined) throw notFound("That bill does not exist.");

  const supabase = await getDataClient();

  const { error } = await supabase.rpc("set_bill_archived", {
    p_bill_id: billId,
    p_archived: archived,
  });

  if (error) throw mapWriteError(error, "the bill");
}
