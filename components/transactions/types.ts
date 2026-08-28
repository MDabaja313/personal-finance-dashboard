import type { ActionState, FormAction } from "@/lib/actions/types";
import type { CalendarDate, Cents, TransactionKind } from "@/lib/types";

/**
 * Display-ready row — account/category ids already resolved to names.
 *
 * The read-only shape, shared by `/transactions` and the dashboard's recent
 * list. Kept separate from the editable one below so a surface that only
 * *shows* transactions is not obliged to supply ids and an edit flag it has no
 * use for.
 */
export interface TransactionDisplayRow {
  id: string;
  date: CalendarDate;
  merchant: string;
  accountName: string;
  categoryName: string | null;
  kind: TransactionKind;
  amountCents: Cents;
}

/**
 * A display row plus what the edit form and its controls need.
 *
 * Ids are carried alongside names because they answer different questions: the
 * *name* is what a person reads, and it may resolve through an archived
 * category (historical rows keep their labels, which is why `getCategories()`
 * deliberately returns archived ones); the *id* is what a form control's
 * `value` has to be. Deriving one from the other in a component would mean
 * shipping a lookup map to the browser.
 */
export interface TransactionRow extends TransactionDisplayRow {
  accountId: string;
  categoryId: string | null;
  /**
   * Whether the ordinary edit/delete controls apply to this row.
   *
   * False for movement legs — a transfer or card payment is a *pair* of rows
   * and editing one alone would leave the movement invalid, so CP4 supplies
   * its own controls over the movement parent — and false for `adjustment`
   * rows, which the database refuses to let any UPDATE target and which only
   * CP5's reconciliation may write. Both kinds stay fully visible in history;
   * what they lack is a control that would not work.
   *
   * Computed on the server from the kind, never inferred in the component, so
   * the rule has one definition (`isOrdinaryTransactionKind`) rather than a
   * copy per view.
   */
  editable: boolean;
}

/** An account the entry form may post to — active accounts only. */
export interface AccountOption {
  id: string;
  name: string;
}

/**
 * A category the entry form may post, carrying its kind so the picker can
 * narrow the list to the ones the selected transaction kind permits.
 */
export interface CategoryOption {
  id: string;
  name: string;
  kind: "income" | "expense";
}

/** The three Server Actions the transaction surface needs, handed down as props. */
export interface TransactionMutationActions {
  readonly create: FormAction;
  readonly update: FormAction;
  readonly remove: FormAction;
}

/** The pre-submission `useActionState` value, shared by every form here. */
export const INITIAL_ACTION_STATE: ActionState = {
  status: "idle",
  formError: null,
  fieldErrors: {},
};
