/**
 * Movement form input → validated domain values.
 *
 * A movement is a transfer or a credit-card payment: one parent row plus
 * exactly two transaction legs that sum to zero. This module validates the
 * *whole* movement as one submission, because that is the only unit that can
 * be written — a leg on its own leaves a movement with one leg, which
 * `validate_movement()` rejects at COMMIT.
 *
 * Built from the same CP1 primitives as `lib/validation/transactions.ts`
 * (`zUuid`, `zNotFuture`, `zMoneyCents`) plus the movement kind list in
 * `lib/types/enums.ts`, so no rule here has a second definition anywhere.
 * Pure: Zod and `lib/types` only — no DAL, no clock, no env. ESLint enforces
 * that for `lib/validation/**` and `lib/write-posture.test.ts` proves the fence
 * fires.
 *
 * ## Deliberately separate from the ordinary transaction schemas
 *
 * `lib/validation/transactions.ts` narrows `kind` to
 * `ORDINARY_TRANSACTION_KINDS` and must keep doing so: an ordinary submission
 * naming `transfer` is refused there, and always will be. This file is the
 * only place `transfer`/`credit_card_payment` are acceptable input, and it
 * accepts *nothing else* — `income` posted to a movement form fails as an
 * unselected type. Two schemas rather than one with a branch, so widening
 * either surface can never silently widen the other.
 *
 * ## What this layer is and is not
 *
 * It is a UX layer. Every rule below is applied again by the database:
 * `public.create_movement`/`public.replace_movement` re-check the magnitude,
 * the two-different-accounts rule and the card-payment destination in SQL;
 * `assert_transaction_refs()` re-checks the posted date against the owner's own
 * calendar day and refuses an archived account; `validate_movement()` re-checks
 * the pair at COMMIT. What validation buys is a message a person can act on
 * *before* a query is issued, and a field to attach it to.
 *
 * Three rules it deliberately cannot check, because checking them needs data
 * this layer is not allowed to read: whether each account exists and is active,
 * and whether a card payment's destination is actually a `credit` account.
 * Those belong to the mutation layer's preflight (for the message) and to the
 * RPCs (for the enforcement).
 *
 * ## Five decisions worth stating outright
 *
 * **No owner id is accepted from the caller, ever.** There is no `userId` field
 * on any schema here and there must never be one: the owner comes from
 * `getOwnerId()` in the mutation DAL and from `auth.uid()` inside the RPC.
 *
 * **The amount is a strictly positive magnitude; the server derives both
 * signs.** `movementLegAmountsFor` (`lib/types/enums.ts`) turns it into
 * `-magnitude` for the source leg and `+magnitude` for the destination. A
 * signed field would let a well-formed submission contradict itself — a
 * "transfer" whose legs both credit — and the sum-to-zero invariant would then
 * depend on the client getting it right. Unlike an ordinary transaction, zero
 * is *not* legal here (`transactions_movement_nonzero_ck`): a transfer of
 * nothing is not an event.
 *
 * **No merchant field exists.** A leg's label is composed by the RPC from the
 * movement's kind and the other account's name ("Transfer to High-Yield
 * Savings" / "Transfer from Everyday Checking"), so the pair's two labels are
 * consistent with each other by construction. There is no free-text field on a
 * row a person cannot edit directly.
 *
 * **No category field exists.** Moving money between owned accounts is not
 * consumption. `transactions_movement_no_category_ck` and
 * `assert_transaction_refs()` both refuse one; the absence of the field is the
 * first of the three layers.
 *
 * **`today` is a parameter, so these are factories** — the same arrangement the
 * transaction schemas use, and for the same reason: the ceiling has to be the
 * owner's own calendar day (`getToday()`, derived from `profiles.timezone`), so
 * that the form's message and the database's refusal can never disagree.
 */
import { z } from "zod";

import type { CalendarDate, Cents } from "@/lib/types";
import { MOVEMENT_KINDS, type MovementKind } from "@/lib/types/enums";
import { zMoneyCents } from "@/lib/validation/money";
import { zNotFuture, zUuid } from "@/lib/validation/primitives";

/**
 * `public.movement_kind` — the two paired kinds, and nothing else.
 *
 * Anything else — including a perfectly valid `expense` — fails as an
 * unselected type rather than with a message listing which kinds exist. The
 * control only ever offers two options, so a third arriving means a
 * hand-crafted request, and naming the values that would have worked is a
 * courtesy owed to a person filling in a form, not to a caller probing an
 * endpoint.
 */
export const zMovementKind: z.ZodType<MovementKind, string> = z
  .string({ error: "Select a type." })
  .refine((value): value is MovementKind => (MOVEMENT_KINDS as readonly string[]).includes(value), {
    error: "Select a type.",
  });

/**
 * The amount, as a strictly positive magnitude.
 *
 * `zMoneyCents({ allowNegative: false })` already refuses a minus sign; the
 * extra refinement is what refuses zero, which that schema legitimately allows
 * for ordinary rows. Stated as its own rule with its own message rather than
 * folded into the money parser, because "zero is fine here, not there" is a
 * property of movements, not of money.
 */
const zMovementAmount: z.ZodType<Cents, string> = zMoneyCents({ allowNegative: false }).refine(
  (cents) => cents > 0,
  { error: "Enter an amount greater than zero." }
);

/**
 * One validated movement, ready for `lib/data/mutations/movements.ts`.
 *
 * `amountCents` is the **positive magnitude**, deliberately — not a signed leg
 * amount. Both signed amounts are derived from it, by `movementLegAmountsFor`
 * in TypeScript (for the idempotency comparison) and independently by the RPC
 * in SQL (for the rows actually written). Carrying a magnitude here is what
 * makes those two derivations comparable rather than a value the client chose.
 */
export interface MovementInput {
  /**
   * The movement's own id — the client-generated idempotency key on create,
   * and the id of the movement being edited on replace.
   *
   * A movement id is stable for the movement's whole life: `replace_movement`
   * deletes and re-creates the parent under this same id, so editing a
   * transfer never changes what it is.
   */
  readonly id: string;
  /**
   * The two leg ids, minted once alongside the movement id.
   *
   * On create they make the legs collide with themselves on a retry, exactly
   * as the movement id does. On replace the mutation layer passes the
   * *existing* legs' ids, so an edit preserves each leg's identity instead of
   * minting a new row id for a row that already existed.
   */
  readonly sourceLegId: string;
  readonly destinationLegId: string;
  readonly kind: MovementKind;
  readonly date: CalendarDate;
  /** Debited: this leg is stored at `-amountCents`. */
  readonly fromAccountId: string;
  /** Credited: this leg is stored at `+amountCents`. */
  readonly toAccountId: string;
  /** A strictly positive magnitude. The signs are derived, never submitted. */
  readonly amountCents: Cents;
}

/**
 * The fields every movement form posts, keyed by the control's `name` so
 * `z.flattenError(...).fieldErrors` lands under the right input.
 */
function movementFields(today: CalendarDate) {
  return {
    id: zUuid,
    sourceLegId: zUuid,
    destinationLegId: zUuid,
    kind: zMovementKind,
    date: zNotFuture(today),
    fromAccountId: zUuid,
    toAccountId: zUuid,
    amount: zMovementAmount,
  };
}

/**
 * The cross-field rules, applied after every field has parsed.
 *
 * Attached to a specific field wherever there is one to attach it to: a
 * form-level "something is wrong" for a rule about two named controls would
 * leave a person hunting for which. `toAccountId` carries the same-account
 * message because the destination picker is the one they most likely just
 * changed.
 *
 * The three-distinct-ids rule has no control to attach to at all — those are
 * hidden inputs minted by the form — so it lands on `id`, where the form-level
 * message is what a person will actually see. It exists because two legs
 * sharing an id is a primary-key collision the database would report as a bare
 * conflict, and a movement id colliding with one of its own legs' ids would be
 * a genuinely confusing row to have written.
 */
function refineMovement(
  value: {
    id: string;
    sourceLegId: string;
    destinationLegId: string;
    fromAccountId: string;
    toAccountId: string;
  },
  ctx: z.RefinementCtx
): void {
  if (value.fromAccountId === value.toAccountId) {
    ctx.addIssue({
      code: "custom",
      path: ["toAccountId"],
      message: "Choose a different account to move the money into.",
    });
  }

  const ids = [value.id, value.sourceLegId, value.destinationLegId];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "That submission is malformed. Refresh the page and try again.",
    });
  }
}

function toDomain(value: {
  id: string;
  sourceLegId: string;
  destinationLegId: string;
  kind: MovementKind;
  date: CalendarDate;
  fromAccountId: string;
  toAccountId: string;
  amount: Cents;
}): MovementInput {
  return {
    id: value.id,
    sourceLegId: value.sourceLegId,
    destinationLegId: value.destinationLegId,
    kind: value.kind,
    date: value.date,
    fromAccountId: value.fromAccountId,
    toAccountId: value.toAccountId,
    amountCents: value.amount,
  };
}

/**
 * The create form, parameterized by the owner's calendar day.
 *
 * All three ids are validated as UUIDs like any other untrusted field — they
 * arrive from hidden inputs, which are exactly as trustworthy as visible ones.
 */
export function makeCreateMovementSchema(today: CalendarDate) {
  return z.object(movementFields(today)).superRefine(refineMovement).transform(toDomain);
}

/**
 * The edit form, parameterized by the owner's calendar day.
 *
 * Structurally identical to create apart from what the ids mean: here `id`
 * names an existing movement and the two leg ids name its existing legs. Every
 * editable value is resubmitted whole rather than as a patch — the form always
 * has all of them, and a partial update would need "absent means unchanged"
 * semantics that `date` and `amount` cannot express (blank is a legitimate
 * mistake, not a request to keep the old value).
 */
export function makeUpdateMovementSchema(today: CalendarDate) {
  return z.object(movementFields(today)).superRefine(refineMovement).transform(toDomain);
}

/**
 * Delete. Just the movement id — deleting the *parent* is the whole operation,
 * and the cascade takes both legs. Whether the caller owns it is not a property
 * of the input; that is `movements_delete_own` and the mutation layer's
 * preflight.
 */
export const movementDeleteSchema = z.object({ id: zUuid });
