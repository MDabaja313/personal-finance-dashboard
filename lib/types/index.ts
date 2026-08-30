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

/**
 * One month's income *plan* — what the owner expects to earn, and nothing else.
 *
 * Deliberately not a `Budget`. A budget is a per-category spending limit that
 * `budgetStatus()` compares against `spendingByCategory()`; this is a
 * per-month income target that nothing compares against a category at all.
 * Storing it as a budget row would need a sentinel category, would defeat
 * `assert_budget_category_active_expense()`, and would put a permanently
 * 0%-used meter on `/budgets`.
 *
 * **It is a target, never a figure.** Actual income is derived from
 * `transactions` by `monthlyIncome()` and is never read from here; no account
 * balance, no net worth, and no net-worth snapshot has any awareness of this
 * type. `expectedIncomeCents` is a non-negative magnitude — there is no sign to
 * get wrong, because an expectation has no direction.
 *
 * A month with no plan has no row and no default: `getMonthlyPlan()` returns
 * `undefined`, which the summary renders as "not set" rather than as zero. The
 * two are genuinely different — zero expected income makes every planned
 * expense unallocated, while "not set" makes the question unanswered.
 */
export interface MonthlyPlan {
  id: string;
  period: MonthKey;
  /** Non-negative. What the owner expects to earn this month. */
  expectedIncomeCents: Cents;
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
 * `public.bill_payment_origin` — how a paid occurrence came to reference a
 * transaction, and the fact that decides whether unmarking it may remove that
 * transaction.
 *
 * `linked` — the owner chose one of their own existing transactions. This
 * application did not create it and must never delete it; unmarking clears the
 * reference and leaves the row exactly where it was.
 *
 * `generated` — `public.settle_bill_occurrence` created it, in the same
 * database transaction that marked the occurrence paid, from the bill's own
 * account, the occurrence's own amount and the paid date. Unmarking removes it,
 * because nothing else in the ledger has ever had a reason to point at it.
 *
 * Absent (`undefined`) on every occurrence that references no transaction at
 * all — every scheduled and skipped one, and a paid one settled without a
 * ledger row. `bill_occurrences_transaction_origin_ck` makes the presence of
 * this value and the presence of `transactionId` the same fact.
 *
 * The distinction is not a client-supplied claim:
 * `guard_bill_occurrence_transition()` accepts `generated` only when the
 * referenced transaction's `created_at` equals the current transaction's
 * timestamp, and `authenticated` holds no grant on `transactions.created_at`
 * at all — so a pre-existing row can never be relabelled as generated.
 */
export type BillPaymentOrigin = "linked" | "generated";

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
 * marked paid from a payment that was never recorded as a transaction, and a
 * bill that names no usable account has no ledger row to create. When it *is*
 * present, `transactionOrigin` says where that row came from — and that is the
 * only thing that differs between a payment this application generated and one
 * the owner wrote themselves.
 *
 * **A linked transaction is never altered by the link.** Not recategorised, not
 * re-dated, not re-amounted, not replaced, and not deleted when the occurrence
 * is unmarked. A *generated* one is created by the settlement and removed by
 * its reversal, which is the whole of the difference.
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
  /** Present only when the payment references a transaction. */
  transactionId?: string;
  /** Present if and only if `transactionId` is. */
  transactionOrigin?: BillPaymentOrigin;
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
