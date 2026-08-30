/**
 * Reconciliation form input → validated domain values.
 *
 * Reconciling is not "enter a transaction". A person states what an account's
 * balance *actually is* right now, and the database works out the correction
 * that makes the derived balance match. So there is no amount field here, no
 * kind field, no category field, and no merchant field — those are properties
 * of the row reconciliation happens to produce, not of the question being
 * asked.
 *
 * Built from the same CP1 primitives as every other schema in this directory
 * (`zUuid`, `zNotFuture`, `zMoneyCents`). Pure: Zod and `lib/types` only — no
 * DAL, no clock, no env. ESLint enforces that for `lib/validation/**` and
 * `lib/write-posture.test.ts` proves the fence fires.
 *
 * ## Four fields the client may never supply
 *
 * **No owner id.** There is no `userId` field on any schema here and there
 * must never be one: the owner comes from `getOwnerId()` in the mutation DAL
 * and from `auth.uid()` inside `public.reconcile_account`.
 *
 * **No `kind`.** The kind is `adjustment`, always, and it is written in SQL
 * by the RPC. Accepting it as input would make the reconciliation surface a
 * second way to choose a transaction kind — precisely what
 * `transactions_update_own_ordinary`'s `kind <> 'adjustment'` clause exists to
 * prevent from the other direction.
 *
 * **No category.** An adjustment corrects a balance rather than recording
 * consumption. Two CHECK constraints and `assert_transaction_refs()` all
 * refuse one; the absence of the field is the first of those layers.
 *
 * **No movement.** An adjustment is a single row, never a leg.
 *
 * ## Why the schema is a factory over the account's own type
 *
 * `today` is a parameter for the reason every dated schema here takes one: the
 * ceiling has to be the owner's calendar day (`getToday()`, derived from
 * `profiles.timezone`), so the form's message and
 * `assert_transaction_refs()`'s refusal can never disagree.
 *
 * `accountType` is a parameter for a different reason — it decides *what the
 * balance field means*, and therefore whether a minus sign is acceptable:
 *
 * - A checking, savings, cash or investment account is reconciled against its
 *   **signed actual balance**. An overdrawn current account is a real state a
 *   person needs to be able to state, so a negative figure is accepted.
 * - A credit or loan account is reconciled against the **amount currently
 *   owed**, as a non-negative magnitude. Nobody reads their card statement as
 *   "negative four hundred and fifty dollars", and asking them to type the
 *   internal sign convention would be asking them to understand a storage
 *   detail. `-magnitude` is derived server-side, in
 *   `lib/data/mutations/reconciliation.ts`, from the account's own stored
 *   type.
 *
 * The type is read from the database by the Server Action before this schema
 * is built — never taken from the submission, which is the same arrangement
 * `accountUpdateSchema()` uses and for the same reason: a caller-supplied type
 * would let a hand-crafted request choose which sign convention applied to it.
 * The mutation layer re-reads the type independently regardless, so this
 * parameter only ever decides which *message* a person gets.
 */
import { z } from "zod";

import type { AccountType, CalendarDate, Cents } from "@/lib/types";
import { isLiabilityAccountType } from "@/lib/types/enums";
import { zMoneyCents } from "@/lib/validation/money";
import { zNotFuture, zUuid } from "@/lib/validation/primitives";

/**
 * One validated reconciliation request.
 *
 * `observedCents` is deliberately *not* called a balance or a delta. It is
 * what the person typed, under the convention their account type's form uses,
 * and it becomes a desired internal balance only once the mutation layer has
 * read the account's stored type. Naming it for the input rather than for the
 * output is what stops a later caller assuming a sign it does not carry.
 */
export interface ReconcileInput {
  readonly accountId: string;
  /** The day the observed balance was true. Never later than the owner's today. */
  readonly asOf: CalendarDate;
  /**
   * Signed actual balance for an asset account; non-negative amount owed for a
   * credit or loan account.
   */
  readonly observedCents: Cents;
}

export interface ReconcileSchemaOptions {
  readonly today: CalendarDate;
  /** The account's *stored* type, read by the action. Never submitted. */
  readonly accountType: AccountType;
}

/**
 * The reconcile form, parameterized by the owner's calendar day and by the
 * account's own type.
 *
 * `balance` is the control's `name` so `z.flattenError(...).fieldErrors` lands
 * under the right input whichever question the form asked.
 */
export function makeReconcileSchema({ today, accountType }: ReconcileSchemaOptions) {
  const isLiability = isLiabilityAccountType(accountType);

  return z
    .object({
      accountId: zUuid,
      asOf: zNotFuture(today),
      // `allowNegative` is the entire difference between the two forms. A
      // liability's "amount owed" is a magnitude, and `zMoneyCents` already
      // refuses a minus sign with a message a person can act on ("Enter an
      // amount of zero or more."); an asset's actual balance may legitimately
      // be negative.
      balance: zMoneyCents({ allowNegative: !isLiability }),
    })
    .transform(
      (value): ReconcileInput => ({
        accountId: value.accountId,
        asOf: value.asOf,
        observedCents: value.balance,
      })
    );
}

/**
 * Removing one adjustment. Just its row id.
 *
 * Whether that row is actually an adjustment, and actually the caller's, is
 * not a property of the input — it is the mutation layer's preflight and
 * `transactions_delete_own_non_movement`. What this schema guarantees is only
 * that a UUID was posted.
 */
export const adjustmentDeleteSchema = z.object({ id: zUuid });
