import type { FormAction } from "@/lib/actions/types";
import type { BillFrequency, BillOccurrenceStatus, CalendarDate, Cents } from "@/lib/types";

/**
 * The bill and bill-occurrence Server Actions, bundled so `/bills` can hand
 * them down through `BillCard` → `BillCardActions` as one prop.
 *
 * A type-only import of `lib/actions/types`, which is the only way
 * `components/**` may reach that layer — the actions themselves arrive as
 * values from `app/**`.
 *
 * `restore` covers both "Unmark paid" and "Unskip": they are the same
 * transition back to `scheduled`, and the label is chosen from the
 * occurrence's current status rather than from a second endpoint.
 */
export interface BillMutationActions {
  readonly update: FormAction;
  readonly setArchived: FormAction;
  readonly markPaid: FormAction;
  readonly skip: FormAction;
  readonly restore: FormAction;
}

/**
 * One occurrence, for display and for the per-row controls.
 *
 * A local shape rather than an import of `lib/types`' `BillOccurrence` DTO —
 * `components/**` may import `lib/types` freely, but this shape is
 * deliberately narrower than the DTO in one respect and wider in another:
 * `billId` is dropped (the card already knows which bill it is rendering) and
 * `transactionLabel` is added, because a link is only useful if it says which
 * payment it points at, and resolving that needs the ledger — which happens on
 * the server, in `app/**`.
 *
 * `amountCents` here is **the occurrence's own amount**, fixed when it was
 * generated. It is never the parent bill's current amount, which is the whole
 * point of the model (docs/database-schema.md §13) and is why a history row
 * must never fall back to the card's headline figure.
 */
export interface BillOccurrenceRow {
  readonly id: string;
  readonly dueDate: CalendarDate;
  readonly status: BillOccurrenceStatus;
  /** What *this* instance was due for — never the parent's current amount. */
  readonly amountCents: Cents;
  readonly paidOn?: CalendarDate;
  /** A short human description of the referenced transaction, when there is one. */
  readonly transactionLabel?: string;
  /**
   * True when the referenced transaction was created by settling this
   * occurrence, so unmarking it will remove that transaction too.
   *
   * A boolean rather than the stored `BillPaymentOrigin`, because the history
   * row asks exactly one question of it: does the Unmark control also delete a
   * ledger row? Absent origin and `linked` both answer "no" and are the same
   * answer here, while remaining different facts in the database.
   */
  readonly paymentWasGenerated?: boolean;
}

/**
 * What marking one occurrence paid will create, when nothing is linked instead.
 *
 * Resolved on the server, by the same two rules `public.settle_bill_occurrence`
 * applies: the bill must name an account that is not archived, and the bill's
 * category is carried only when it is an active *expense* category (a bill's
 * category kind is deliberately unconstrained, but an expense transaction's is
 * not). `undefined` on the props means no ledger row will be created at all.
 *
 * It exists so the form can state the effect *before* the button is pressed
 * rather than reporting it afterwards. It is never used to decide anything —
 * the database decides — only to describe.
 */
export interface GeneratedPaymentPreview {
  readonly accountName: string;
  /** Absent when the bill's category cannot legally label an expense. */
  readonly categoryName?: string;
}

/**
 * One option in the mark-paid form's optional transaction picker.
 *
 * Bounded and pre-resolved on the server: `label` already carries the date,
 * merchant, amount and account, so the form renders context without reaching
 * for the ledger itself.
 */
export interface TransactionOption {
  readonly id: string;
  readonly label: string;
}

/** One option in the bill form's optional category or account selector. */
export interface BillReferenceOption {
  readonly id: string;
  readonly name: string;
}

/** Everything the bill form needs to prefill an edit and offer valid choices. */
export interface BillFormValues {
  readonly id: string;
  readonly name: string;
  readonly amountCents: Cents;
  readonly frequency: BillFrequency;
  readonly anchorDate: CalendarDate;
  readonly categoryId?: string;
  readonly accountId?: string;
}
