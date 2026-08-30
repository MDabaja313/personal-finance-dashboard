import type { ActionState, FormAction } from "@/lib/actions/types";
import type { AccountType, CalendarDate, Cents } from "@/lib/types";
import type { MovementKind } from "@/lib/types/enums";

/**
 * The movement surface's own prop shapes.
 *
 * Kept apart from `components/transactions/types.ts` rather than folded into
 * it, even though both render on `/transactions`. A movement is not a
 * transaction with extra fields: it has no merchant a person may type, no
 * category, no signed amount, and its unit of editing is a *pair* of rows. The
 * one thing the two surfaces share is that a `TransactionRow` may carry a
 * `MovementEditRow`, and that dependency points one way — this module imports
 * nothing from there.
 */

/**
 * An account a movement form may post, carrying its `type` so the destination
 * picker can narrow itself.
 *
 * `type` is here and absent from `AccountOption` because only this surface
 * needs it: a credit-card payment's destination must be a `credit` account
 * (`lib/types/index.ts`'s stated convention, enforced by the mutation
 * preflight and again inside `public.create_movement`), so the picker has to be
 * able to tell which accounts qualify. An ordinary transaction has no such
 * rule, so its option shape stays two fields.
 *
 * Active accounts only — the page filters archived ones out before passing
 * them, since offering one would be offering a control that always fails.
 */
export interface MovementAccountOption {
  id: string;
  name: string;
  type: AccountType;
}

/**
 * One editable movement, as the row that represents it hands it to the form.
 *
 * Everything here is resolved on the server by `getMovements()` — including
 * which account is the source and which is the destination, which is derived
 * once from the legs' signs rather than re-derived per consumer. `amountCents`
 * is therefore the **positive magnitude**, never a signed leg amount: the form
 * collects "how much" and two account roles, and the database derives both
 * signs.
 *
 * The two leg ids travel with it because an edit reuses them — replacing a
 * movement preserves each leg's row identity rather than minting a new id for a
 * row that already existed.
 */
export interface MovementEditRow {
  id: string;
  kind: MovementKind;
  date: CalendarDate;
  fromAccountId: string;
  toAccountId: string;
  sourceLegId: string;
  destinationLegId: string;
  /** Positive magnitude. */
  amountCents: Cents;
  /** The source leg's rendered label, for accessible control names. */
  label: string;
}

/** The three movement Server Actions, handed down as props. */
export interface MovementMutationActions {
  readonly create: FormAction;
  readonly update: FormAction;
  readonly remove: FormAction;
}

/** The pre-submission `useActionState` value, shared by every movement form. */
export const INITIAL_MOVEMENT_ACTION_STATE: ActionState = {
  status: "idle",
  formError: null,
  fieldErrors: {},
};
