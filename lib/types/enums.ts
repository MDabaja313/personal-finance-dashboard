/**
 * The database enum label sets, in one place.
 *
 * These arrays are the TypeScript mirror of the `create type ... as enum`
 * statements in `supabase/migrations/20260822150002_enums_and_tables.sql`,
 * plus every later `alter type ... add value`, which together are the
 * authority — `lib/types/enums.test.ts` parses the migrations directory and
 * fails if any array here drifts from it, in content *or* order.
 *
 * They moved out of `lib/data/mappers.ts` in Phase 7 CP1 because reads are no
 * longer the only consumer: a mapper narrows database text *into* the domain,
 * while validation narrows untrusted form text *before* it reaches the
 * database, and both must agree on exactly one list. `lib/types` is the layer
 * both may import (`lib/validation/**` is fenced off from `lib/data/**`), and
 * nothing here carries a client, a clock, or an env read.
 *
 * Order is meaningful and preserved: a Postgres enum sorts by declaration
 * order, so these arrays double as the canonical display/sort order for their
 * labels.
 *
 * `MOVEMENT_KINDS` and `BILL_OCCURRENCE_STATUSES` are here even though no read
 * path needed them originally (`movements` was unreadable by `authenticated`
 * until Phase 7 CP4, and `bill_occurrences.status` drives a query filter rather
 * than a DTO field).
 *
 * `TRANSACTION_KINDS` gained `adjustment` in Phase 7 CP3, appended last because
 * `alter type ... add value` with no BEFORE/AFTER appends. Membership in this
 * list means "a row can carry this kind and must render correctly" — it does
 * **not** mean a person may enter one. Which kinds the ordinary entry form
 * offers is `ORDINARY_TRANSACTION_KINDS` below, and the two lists are
 * deliberately different objects rather than one list with a filter, so
 * widening the readable set can never silently widen the writable one.
 */
import type { AccountType, BillFrequency, Category, Cents, TransactionKind } from "@/lib/types";
import { toCents } from "@/lib/types";

/** `public.account_type`. */
export const ACCOUNT_TYPES: readonly AccountType[] = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "loan",
];

/**
 * Which optional account columns a given type may carry at all — the TypeScript
 * mirror of `accounts_credit_limit_domain_ck` and
 * `accounts_interest_rate_domain_ck`.
 *
 * Here rather than in `lib/validation/accounts.ts` for the same reason the enum
 * lists are here: two layers need the identical rule and `lib/types` is the one
 * both may import. The account form renders a field only where the type permits
 * it, the schema rejects one supplied where it does not, and a component
 * importing `lib/validation/**` directly would pull Zod into the client bundle
 * for what is a two-line predicate.
 */
export function allowsCreditLimit(type: AccountType): boolean {
  return type === "credit";
}

export function allowsInterestRate(type: AccountType): boolean {
  return type === "credit" || type === "loan";
}

/** `public.category_kind`. */
export const CATEGORY_KINDS: readonly Category["kind"][] = ["income", "expense"];

/** `public.transaction_kind`, in declaration order. */
export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  "income",
  "expense",
  "refund",
  "transfer",
  "credit_card_payment",
  "adjustment",
];

/**
 * The kinds the ordinary create/edit surface may produce — the *writable*
 * subset of `TRANSACTION_KINDS`, and the narrowest thing that can be called a
 * transaction kind.
 *
 * Everything excluded is excluded for a structural reason, not a UI one:
 *
 * - `transfer` / `credit_card_payment` are **paired legs**. One cannot be
 *   created, edited, or deleted on its own without leaving a movement with one
 *   leg — which `validate_movement()` rejects at COMMIT. Creating them is a
 *   two-leg operation over a movement parent, and that is CP4.
 * - `adjustment` is a reconciliation outcome, not an entry. The database
 *   refuses to let an UPDATE target one or turn an ordinary row into one
 *   (`transactions_update_own_ordinary`), so this list is the *first* of two
 *   layers saying so rather than the only one.
 *
 * A separate array rather than `TRANSACTION_KINDS.filter(...)`: a filter would
 * silently admit any future kind that failed to match its predicate, and the
 * set of kinds a person may write should never grow by omission.
 */
export type OrdinaryTransactionKind = Extract<TransactionKind, "income" | "expense" | "refund">;

export const ORDINARY_TRANSACTION_KINDS: readonly OrdinaryTransactionKind[] = [
  "income",
  "expense",
  "refund",
];

export function isOrdinaryTransactionKind(kind: string): kind is OrdinaryTransactionKind {
  return (ORDINARY_TRANSACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * The category kind a transaction of this kind must use.
 *
 * The TypeScript mirror of the rule `assert_transaction_refs()` enforces in the
 * database, here rather than in `lib/validation/**` for the same reason
 * `allowsCreditLimit` is here: two layers need the identical rule and
 * `lib/types` is the one both may import. The entry form filters its category
 * options with it; the mutation layer's preflight checks the stored category
 * against it; the trigger has the final say.
 *
 * A refund takes an **expense** category, deliberately. A refund is not income
 * — it reduces the spend of the category it is refunding
 * (`countsAsSpending` in `lib/finance/transactions.ts`), so it has to be filed
 * against the same category the original expense was.
 */
export function categoryKindFor(kind: OrdinaryTransactionKind): Category["kind"] {
  return kind === "income" ? "income" : "expense";
}

/**
 * A non-negative magnitude plus a kind → the signed `Cents` actually stored.
 *
 * The TypeScript mirror of `transactions_sign_by_kind_ck`. Entry forms collect
 * a magnitude and never a signed amount: a minus sign typed into an "Expense"
 * form is ambiguous (did they mean a bigger expense, or a refund?), and a
 * signed field lets a well-formed submission contradict its own kind. Deriving
 * the sign server-side from the kind removes the contradiction entirely.
 *
 * Zero stays zero — a zero-amount ordinary row is legal in this schema (a fully
 * discounted order, a waived fee), and the check constraint is non-strict for
 * exactly that reason. `-0` is normalized away: it is `=== 0` but stringifies
 * as "-0" and survives into JSON.
 *
 * Throws on a negative magnitude rather than taking its absolute value. The
 * caller is `lib/validation/**`, which has already rejected a negative amount
 * with a message a person can act on; silently flipping one here would mean a
 * value that bypassed validation still produced a plausible-looking row.
 */
export function signedAmountFor(kind: OrdinaryTransactionKind, magnitudeCents: Cents): Cents {
  if (magnitudeCents < 0) {
    throw new Error("signedAmountFor requires a non-negative magnitude.");
  }
  if (kind === "expense" && magnitudeCents !== 0) return toCents(-magnitudeCents);
  return magnitudeCents;
}

/**
 * `public.movement_kind` — deliberately narrower than `TransactionKind`, so
 * "a movement can only be one of the two paired kinds" is a type-level fact
 * rather than a convention. Derived by `Extract` rather than re-spelled, so a
 * future `TransactionKind` rename cannot leave this union silently stale.
 */
export type MovementKind = Extract<TransactionKind, "transfer" | "credit_card_payment">;

export const MOVEMENT_KINDS: readonly MovementKind[] = ["transfer", "credit_card_payment"];

export function isMovementKindLabel(kind: string): kind is MovementKind {
  return (MOVEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The two signed leg amounts of one movement, derived from a non-negative
 * magnitude.
 *
 * The TypeScript mirror of what `public.create_movement` does in SQL, and the
 * movement counterpart of `signedAmountFor`: the entry form collects "how
 * much" and picks two accounts, and the *roles* of those accounts — source and
 * destination — decide the signs. A signed field would let a well-formed
 * submission contradict itself (a "transfer" whose two legs both credit), and
 * the only way to resolve that is to pick one and discard the other. Deriving
 * removes the contradiction, and makes `legs sum to zero` true by construction
 * rather than by the caller getting it right.
 *
 * The database derives the same pair independently — this function's result is
 * never posted. It exists so the mutation layer can compare a *stored*
 * movement against the payload a retry would have written, which is what tells
 * an idempotent retry apart from a conflicting resubmission.
 *
 * Throws on a magnitude that is not strictly positive, rather than coercing
 * one. Zero is legal for an ordinary transaction (a waived fee) and illegal
 * for a movement leg (`transactions_movement_nonzero_ck`) — a transfer of
 * nothing is not an event — and `lib/validation/movements.ts` has already
 * rejected it with a message a person can act on.
 */
export interface MovementLegAmounts {
  readonly sourceCents: Cents;
  readonly destinationCents: Cents;
}

export function movementLegAmountsFor(magnitudeCents: Cents): MovementLegAmounts {
  if (magnitudeCents <= 0) {
    throw new Error("movementLegAmountsFor requires a positive magnitude.");
  }
  return {
    sourceCents: toCents(-magnitudeCents),
    destinationCents: magnitudeCents,
  };
}

/**
 * Whether this row is one leg of a movement.
 *
 * A kind test rather than a `movementId !== undefined` test, and the two are
 * equivalent by `transactions_movement_biconditional_ck` — a row carries a
 * movement id if and only if its kind is a movement kind. The kind is what the
 * display layer already has on every row, including the ones the DTO does not
 * carry a movement id for.
 */
export function isMovementKind(kind: TransactionKind): kind is MovementKind {
  return (MOVEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * `public.bill_occurrence_status`. The `BillOccurrence` DTO itself does not
 * exist yet (DEVELOPMENT_PLAN.md defers it to the Phase 7 mark-as-paid work);
 * this is the label set that DTO and its validation will share.
 */
export type BillOccurrenceStatus = "scheduled" | "paid" | "skipped";

export const BILL_OCCURRENCE_STATUSES: readonly BillOccurrenceStatus[] = [
  "scheduled",
  "paid",
  "skipped",
];

/** `public.bill_frequency`. */
export const BILL_FREQUENCIES: readonly BillFrequency[] = ["weekly", "biweekly", "monthly", "yearly"];
