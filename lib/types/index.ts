/**
 * Money is always represented as integer minor units (cents), never floats.
 * `toCents` is the only way to construct a `Cents` value, so the
 * safe-integer invariant can't be bypassed by an `as Cents` cast elsewhere.
 */
export type Cents = number & { readonly __brand: "Cents" };

export function toCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Unsafe integer value for Cents: ${value}`);
  }
  return value as Cents;
}

/** Calendar date as 'YYYY-MM-DD'. Never a timestamp/instant. */
export type CalendarDate = string;

/** 'YYYY-MM' budget/snapshot period. */
export type MonthKey = string;

export type AccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit"
  | "investment"
  | "loan";

export interface Account {
  id: string;
  name: string;
  institution: string;
  type: AccountType;
  /** Signed: assets normally positive, liabilities (credit/loan) normally negative. */
  balanceCents: Cents;
  /** Credit accounts only. */
  creditLimitCents?: Cents;
  /** Credit/loan accounts only, integer basis points (1899 = 18.99%). */
  interestRateBps?: number;
  isArchived: boolean;
}

export interface Category {
  id: string;
  name: string;
  kind: "income" | "expense";
  /**
   * Archived categories stay readable and keep resolving names for the
   * historical rows that reference them — `getCategories()` deliberately
   * returns them. The flag is what lets a management surface show archive
   * state while a future new-entry picker hides archived options.
   */
  isArchived: boolean;
}

/**
 * Meaning is carried by `kind` AND `amountCents`'s sign together — never
 * sign alone. `transfer` and `credit_card_payment` move money between two
 * owned accounts and are excluded from income/spending/cash-flow, but both
 * legs remain visible in their own account's history.
 *
 * Sign convention:
 *   income                → positive
 *   expense                → negative
 *   refund                 → positive
 *   transfer               → source leg negative, destination leg positive
 *   credit_card_payment    → source (checking) leg negative, destination (card) leg positive
 *   adjustment             → either sign, whatever reconciles the balance
 *
 * `adjustment` is the reconciliation kind. Phase 7 CP3 added it to the
 * database enum (`supabase/migrations/20260828120001_transaction_kind_adjustment.sql`)
 * so an adjustment row can be *read*, filtered, and rendered safely before one
 * can exist. Nothing writes one yet: the ordinary entry form accepts
 * income/expense/refund only, and the database's UPDATE policy makes an
 * adjustment row non-editable outright. Reconciliation — the only intended way
 * to create one — is CP5.
 *
 * It carries no category (`transactions_adjustment_no_category_ck`): it
 * corrects an account's balance rather than recording consumption, so
 * attributing it to a category would push a reconciliation difference into
 * budget utilisation and the income/expense split. `lib/finance/transactions.ts`
 * therefore counts it as neither spending nor income — like a movement leg, it
 * moves a balance without being an economic event.
 */
export type TransactionKind =
  | "income"
  | "expense"
  | "refund"
  | "transfer"
  | "credit_card_payment"
  | "adjustment";

export interface Transaction {
  id: string;
  accountId: string;
  date: CalendarDate;
  /** Payee/counterparty, e.g. "Whole Foods", "Employer Inc". */
  merchant: string;
  kind: TransactionKind;
  /**
   * Omitted for `transfer`/`credit_card_payment` legs — moving money
   * between owned accounts is not consumption and gets no category — and
   * for `adjustment` rows, which correct a balance rather than record one.
   * Legitimately absent on an ordinary row too: uncategorized is legal.
   */
  categoryId?: string;
  /**
   * Present only on `transfer`/`credit_card_payment` legs. Both legs of one
   * movement share this id; their amounts sum to zero.
   */
  movementId?: string;
  amountCents: Cents;
}

export interface Budget {
  id: string;
  categoryId: string;
  period: MonthKey;
  limitCents: Cents;
}

export type BillFrequency = "weekly" | "biweekly" | "monthly" | "yearly";

export interface Bill {
  id: string;
  name: string;
  amountCents: Cents;
  /** Next occurrence — bills are recurring, so this is always the upcoming due date. */
  dueDate: CalendarDate;
  frequency: BillFrequency;
  categoryId?: string;
  accountId?: string;
}

/**
 * `public.bill_occurrence_status`. The label set lives in `lib/types/enums.ts`
 * (`BILL_OCCURRENCE_STATUSES`); the union lives here, beside every other DTO
 * union, so `lib/validation/**` and `lib/data/**` can both reach it without
 * either importing the other.
 */
export type BillOccurrenceStatus = "scheduled" | "paid" | "skipped";

/**
 * One concrete due instance of a recurring bill — Phase 7 CP7's addition to
 * the domain. Deferred until now on purpose: nothing rendered an occurrence
 * before there was a way to mark one paid.
 *
 * `amountCents` is **not** a live reference to the parent bill's current
 * amount. It was copied from `bills.amount_cents` at generation time and from
 * then on stands alone as what this instance was actually due for
 * (docs/database-schema.md §13). Editing a bill's amount later can never
 * change it, which is exactly what makes a paid occurrence a record of what
 * happened rather than a projection of what the bill costs today.
 *
 * `transactionId` is legitimately absent on a paid occurrence: a bill can be
 * marked paid from a payment that was never recorded as a transaction. When it
 * is present it names one of the owner's own transactions, and **nothing about
 * that transaction is altered by the link** — marking a bill paid is bookkeeping
 * about an obligation, not a ledger event. Neither a balance, a category, nor
 * an amount moves.
 *
 * `paidOn` is present if and only if `status` is `paid`
 * (`bill_occurrences_status_consistency_ck`).
 */
export interface BillOccurrence {
  id: string;
  billId: string;
  dueDate: CalendarDate;
  status: BillOccurrenceStatus;
  /** Fixed at generation time — never the parent bill's current amount. */
  amountCents: Cents;
  /** Present only when the payment was linked to an existing transaction. */
  transactionId?: string;
  /** Present if and only if `status` is `paid`. */
  paidOn?: CalendarDate;
}

export interface Goal {
  id: string;
  name: string;
  targetCents: Cents;
  savedCents: Cents;
  targetDate?: CalendarDate;
}

/**
 * assetsCents/liabilitiesCents are both positive; netWorthCents is stored
 * explicitly as assetsCents - liabilitiesCents so the convention is never
 * ambiguous at the call site. Never compare these against signed Account
 * balances directly.
 */
export interface NetWorthSnapshot {
  month: MonthKey;
  assetsCents: Cents;
  liabilitiesCents: Cents;
  netWorthCents: Cents;
}
