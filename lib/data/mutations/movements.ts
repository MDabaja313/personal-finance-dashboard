import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { getMovements, type Movement } from "@/lib/data/movements";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, invalidInput, notFound } from "@/lib/errors";
import type { MovementInput } from "@/lib/validation/movements";

/**
 * The write half of the movements DAL — transfers and credit-card payments.
 *
 * ## The rules this module keeps, unchanged from CP2 and CP3
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()` and
 * uses what it returns, and the two RPCs it invokes take no owner either —
 * they derive it from `auth.uid()` inside the database. There is no `userId`
 * argument anywhere on this path, so there is nothing for a caller to get
 * wrong: a Server Action is an independently reachable endpoint that may never
 * have rendered a guarded layout.
 *
 * **Every statement carries an explicit owner predicate** on top of RLS.
 * `movements_select_own` / `movements_insert_own` / `movements_delete_own` are
 * the enforced floor and stay that way; the `.eq("user_id", ownerId)` on top is
 * defense in depth, and it is what makes a foreign id return "no rows" rather
 * than depending solely on a policy being correct. The two RPCs re-apply the
 * same predicate in SQL.
 *
 * **No navigation, no revalidation.** Both are fenced out of
 * `lib/data/mutations/**` by ESLint, because both signal by throwing and the
 * action layer's `attempt()` catches everything.
 *
 * **Errors are typed, never raw.** Every failed response goes through
 * `mapWriteError`, which never quotes a PostgREST message.
 *
 * ## Why create and replace are RPCs and delete is not
 *
 * A movement is a parent row plus exactly two legs, and the database refuses
 * every partial form of it — a childless movement fails `validate_movement()`
 * at COMMIT, and a leg naming a movement that does not exist yet fails the
 * non-deferrable composite FK immediately. PostgREST issues one statement per
 * request, each in its own transaction, so **no sequence of PostgREST calls can
 * produce a movement at all.** `public.create_movement` and
 * `public.replace_movement` (both `SECURITY INVOKER`, both running under the
 * caller's own RLS) are the only paths that exist, which is also what makes
 * their checks a real boundary rather than an application-layer suggestion.
 *
 * Deleting is different: it is genuinely one statement. Removing the *parent*
 * cascades both legs through `transactions_movement_fk`, and
 * `validate_movement()` skips a movement whose parent is gone — that skip is
 * exactly what distinguishes the legitimate cascade from an illegitimate
 * direct leg deletion. So `deleteMovement` is a plain PostgREST delete, and
 * wrapping it in a function would add a privilege surface and no guarantee.
 *
 * ## What this module deliberately cannot do
 *
 * **It cannot touch a leg directly.** No function here writes to
 * `transactions` at all. `transactions_update_own_ordinary` and
 * `transactions_delete_own_non_movement` both carry `movement_id IS NULL`, so
 * a leg is invisible to both statements regardless — and the reverse holds
 * too: `lib/data/mutations/transactions.ts` refuses a movement leg by name
 * before it ever issues a query. The two surfaces are disjoint in both
 * directions, at three layers each.
 *
 * **It cannot choose a merchant.** A leg's label is composed inside the RPC
 * from the movement's kind and the other account's name, so the pair's two
 * labels are consistent by construction and no free text reaches a row a
 * person cannot edit directly.
 *
 * ## Why the preflights exist
 *
 * Every function reads before it writes. That is not an authorization check —
 * RLS, the column-scoped GRANT and the RPCs' own checks are — it is an
 * error-quality check, and on create it is load-bearing for a second reason:
 * the read-back is how an idempotent retry is told apart from a conflicting
 * resubmission.
 */

/** The one movement behind `movementId`, or `undefined`. */
async function readOwnMovement(movementId: string): Promise<Movement | undefined> {
  const movements = await getMovements([movementId]);
  return movements.length === 1 ? movements[0] : undefined;
}

/**
 * Refuses an account that does not exist, is not the caller's, or is archived.
 *
 * The archived rule is "unarchive it first", and it is the same rule an
 * ordinary transaction gets, for the same reason: CP2's
 * `accounts_guard_update()` only permits archiving once an account's derived
 * balance is exactly zero, and `lib/finance/accounts.ts` excludes archived
 * accounts from net worth and from the asset/liability totals. Moving money
 * into or out of one would create a balance that exists in the ledger and in no
 * summary.
 *
 * The database enforces it too — `assert_transaction_refs()` fires on both leg
 * inserts — so this is about the sentence a person reads, not about whether the
 * write is refused.
 */
async function assertAccountUsable(accountId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("accounts")
    .select("is_archived")
    .eq("id", accountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transfer");

  const rows = data as { is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That account does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That account is archived. Unarchive it before using it.");
  }
}

/**
 * Refuses a credit-card payment whose destination is not a credit account.
 *
 * The repository states the convention outright (`lib/types/index.ts`:
 * "source (checking) leg negative, destination (card) leg positive") and
 * `lib/finance/accounts.ts` classifies `credit` as a liability whose balance is
 * stored negative — so a card payment is precisely the movement that raises
 * that balance toward zero. A payment whose destination is not a card is not a
 * card payment.
 *
 * Nothing is checked about the *source*'s type, deliberately: paying a card
 * from cash, from savings, or from another card are all things a person may
 * legitimately record, and refusing them would be inventing a rule the rest of
 * the application does not have.
 *
 * `public.create_movement` enforces the same rule in SQL, on the only path that
 * can write a movement at all. This is the message layer.
 */
async function assertDestinationUsable(input: MovementInput): Promise<void> {
  if (input.kind !== "credit_card_payment") return;

  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("accounts")
    .select("type")
    .eq("id", input.toAccountId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transfer");

  const rows = data as { type: string }[];
  if (rows.length !== 1) throw notFound("That account does not exist.");
  if (rows[0].type !== "credit") {
    throw invalidInput("A card payment must be paid into a credit account.");
  }
}

/** Every target preflight, run together — they are independent reads. */
async function assertTargetsUsable(input: MovementInput): Promise<void> {
  await Promise.all([
    assertAccountUsable(input.fromAccountId),
    assertAccountUsable(input.toAccountId),
    assertDestinationUsable(input),
  ]);
}

/** The RPC argument object, built once so create and replace cannot drift. */
function rpcArgs(input: MovementInput) {
  return {
    p_movement_id: input.id,
    p_kind: input.kind,
    p_date: input.date,
    p_from_account_id: input.fromAccountId,
    p_to_account_id: input.toAccountId,
    // A positive magnitude. Both signs are derived inside the RPC, so nothing
    // signed crosses this boundary in either direction.
    p_amount_cents: input.amountCents,
    p_source_leg_id: input.sourceLegId,
    p_destination_leg_id: input.destinationLegId,
  };
}

/**
 * Whether a stored movement is exactly the movement this input would have
 * written.
 *
 * Field by field rather than by serializing both sides: a stringify comparison
 * would depend on key order and on how `undefined` versus `null` happened to
 * serialize. Every field of the persisted movement is compared — kind, date,
 * both accounts in their *roles*, both leg ids, and the magnitude. Comparing a
 * subset would make some edited resubmission silently indistinguishable from a
 * retry, which is the exact failure this whole mechanism exists to prevent.
 *
 * The leg ids are part of the payload on purpose. A movement carrying the
 * caller's key but a different pair of leg row ids is not the movement this
 * submission would have produced, even if every visible value matched.
 */
function matchesPayload(stored: Movement, input: MovementInput): boolean {
  return (
    stored.id === input.id &&
    stored.kind === input.kind &&
    stored.date === input.date &&
    stored.fromAccountId === input.fromAccountId &&
    stored.toAccountId === input.toAccountId &&
    stored.sourceLegId === input.sourceLegId &&
    stored.destinationLegId === input.destinationLegId &&
    stored.amountCents === input.amountCents
  );
}

export interface MovementWriteResult {
  readonly id: string;
  /**
   * True when nothing was written this time because the requested state was
   * already exactly what the database held.
   *
   * On create that means an identical retry under the same idempotency key. On
   * replace it means an edit that changed nothing. The caller treats both as a
   * success, because in both cases the person's request is satisfied.
   */
  readonly deduplicated: boolean;
}

/**
 * Creates one movement — a parent plus both legs — atomically.
 *
 * ## The idempotency contract, and why 23505 is not simply "fine"
 *
 * The form mints one movement UUID and one UUID per leg when it mounts and
 * keeps all three until the submission logically succeeds, so a double-clicked
 * or retried submit collides with itself on the movements primary key rather
 * than writing a second transfer. That collision is the *only* signal
 * available: two £50 transfers from checking to savings on the same day are a
 * completely legitimate pair, so nothing about the contents could distinguish a
 * duplicate from a genuine second movement.
 *
 * Treating any 23505 as success would be wrong in two distinct ways, and both
 * are handled separately below:
 *
 * 1. **The key exists but the movement differs.** The form was edited and
 *    resubmitted without a fresh key, or a request was replayed with altered
 *    fields. Reporting success would tell the person their edit was saved when
 *    the stored movement still holds the original values. This is a `conflict`.
 * 2. **The key belongs to someone else.** RLS makes their movement invisible,
 *    so the read-back finds nothing. Reporting success would confirm that a
 *    specific UUID exists in another owner's data — and would claim a write
 *    that never happened. This falls through as the ordinary unique conflict it
 *    is.
 *
 * A leg-id collision reaches the same place: the RPC's leg INSERT raises 23505
 * too, and the read-back then decides whether the movement behind the key is
 * this submission's own.
 *
 * There is no idempotency table and no middleware. The primary key already
 * enforces uniqueness, transactionally, with no second store to keep in step
 * and nothing to expire.
 */
export async function createMovement(input: MovementInput): Promise<MovementWriteResult> {
  await assertTargetsUsable(input);

  const supabase = await getDataClient();

  const { error } = await supabase.rpc("create_movement", rpcArgs(input));

  if (error === null) return { id: input.id, deduplicated: false };

  const mapped = mapWriteError(error, "the transfer");
  // Anything but a unique violation is a real failure — a check violation from
  // the RPC or from assert_transaction_refs(), a privilege problem, an
  // unreachable database. Only 23505 is a candidate for the idempotent-retry
  // interpretation.
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnMovement(input.id);
  // Case 2: the key is not ours. Fall through as the plain unique conflict.
  if (existing === undefined) throw mapped;

  if (!matchesPayload(existing, input)) {
    // Case 1: our key, different movement.
    throw conflict("A different transfer was already saved with that submission.");
  }

  return { id: input.id, deduplicated: true };
}

/**
 * Replaces one owned movement, atomically, under its original id.
 *
 * ## The no-op short circuit
 *
 * The stored movement is read first, and if it already equals the requested
 * state exactly, this returns without calling the RPC at all. That is not
 * merely an optimization: `replace_movement` deletes and re-creates both legs,
 * so a rewrite that changes nothing would still give both rows a new
 * `created_at` — the `date DESC, created_at DESC, id ASC` ordering's tie-break
 * — and silently reorder same-day history for a submission the person did not
 * change. Doing nothing is the correct response to "make it what it already
 * is".
 *
 * It also makes replace idempotent in the same sense create is: re-submitting
 * an edit that already landed is a success, not a second rewrite.
 *
 * ## Why the whole movement is rewritten otherwise
 *
 * An edit can change the amount, the date, the kind, and either account, and
 * every one of those has to land on *both* legs at once or on neither. There is
 * no statement that could rewrite one leg — the UPDATE policy makes legs
 * invisible — and two sequential updates would pass through a state where the
 * pair does not sum to zero. `replace_movement` deletes the parent (cascading
 * both legs) and re-creates the whole movement inside one transaction, so a
 * refused replacement leg aborts everything and leaves the original pair
 * untouched, byte for byte.
 *
 * The existing leg ids are passed back in by the caller, so an edit preserves
 * each leg's row identity rather than minting a new id for a row that already
 * existed.
 */
export async function replaceMovement(input: MovementInput): Promise<MovementWriteResult> {
  const existing = await readOwnMovement(input.id);
  if (existing === undefined) throw notFound("That transfer does not exist.");

  if (matchesPayload(existing, input)) return { id: input.id, deduplicated: true };

  await assertTargetsUsable(input);

  const supabase = await getDataClient();

  const { error } = await supabase.rpc("replace_movement", rpcArgs(input));

  if (error) throw mapWriteError(error, "the transfer");

  return { id: input.id, deduplicated: false };
}

/**
 * Deletes one owned movement, and with it both of its legs.
 *
 * The statement targets the *parent*, which is the only correct way to remove a
 * transfer or card payment: `transactions_movement_fk` is `ON DELETE CASCADE`,
 * so both legs go with it in the same transaction, and `validate_movement()`
 * skips a movement whose parent no longer exists — which is precisely what
 * distinguishes this from deleting a leg and stranding its partner. Deleting a
 * leg directly is not merely discouraged; `transactions_delete_own_non_movement`
 * makes legs invisible to DELETE, so it is not expressible.
 *
 * Both accounts are checked first, for the reason `assertAccountUsable`
 * documents: archiving requires a zero derived balance, so removing a movement
 * that touches an archived account would leave money in an account every total
 * ignores. The database does not enforce this half — the DELETE policy is
 * deliberately about *rows*, not about account state — so, exactly as with
 * `deleteTransaction`, this is one of the few rules where the mutation layer is
 * the only enforcement, and it is recorded as such rather than implied.
 *
 * The preflight read also turns a deleted or foreign id into a clean
 * `not_found` rather than a silent zero-row no-op.
 */
export async function deleteMovement(movementId: string): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnMovement(movementId);
  if (existing === undefined) throw notFound("That transfer does not exist.");

  await Promise.all([
    assertAccountUsable(existing.fromAccountId),
    assertAccountUsable(existing.toAccountId),
  ]);

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("movements")
    .delete()
    .eq("id", movementId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the transfer");
}
