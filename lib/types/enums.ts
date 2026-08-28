/**
 * The database enum label sets, in one place.
 *
 * These arrays are the TypeScript mirror of the `create type ... as enum`
 * statements in `supabase/migrations/20260822150002_enums_and_tables.sql`,
 * which is the authority — `lib/types/enums.test.ts` parses that migration and
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
 * `MOVEMENT_KINDS` and `BILL_OCCURRENCE_STATUSES` are new here — the schema has
 * had both enums since Phase 4, but no read path needed them (`movements` is
 * unreadable by `authenticated`, and `bill_occurrences.status` drives a query
 * filter rather than a DTO field). There is deliberately **no `adjustment`
 * member** on `TRANSACTION_KINDS`: the balance-adjustment/reconciliation
 * mechanism is a recorded future prerequisite in DEVELOPMENT_PLAN.md, not
 * something CP1 invents ahead of its design.
 */
import type { AccountType, BillFrequency, Category, TransactionKind } from "@/lib/types";

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

/** `public.transaction_kind`. */
export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  "income",
  "expense",
  "refund",
  "transfer",
  "credit_card_payment",
];

/**
 * `public.movement_kind` — deliberately narrower than `TransactionKind`, so
 * "a movement can only be one of the two paired kinds" is a type-level fact
 * rather than a convention. Derived by `Extract` rather than re-spelled, so a
 * future `TransactionKind` rename cannot leave this union silently stale.
 */
export type MovementKind = Extract<TransactionKind, "transfer" | "credit_card_payment">;

export const MOVEMENT_KINDS: readonly MovementKind[] = ["transfer", "credit_card_payment"];

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
