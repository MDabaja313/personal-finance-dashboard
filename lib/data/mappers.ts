/**
 * Pure DB-row → domain-DTO mappers, plus the field validators they are built
 * from.
 *
 * No Supabase client, no `next/headers`, no clock, no fixtures — everything
 * here is a total function of its arguments, which is what makes it unit
 * testable offline and reusable from every checkpoint's query code.
 *
 * Three rules this module exists to enforce mechanically:
 *
 * 1. **No raw row escapes.** Every DAL return path goes through a mapper; a
 *    row object is never spread into a DTO. Combined with explicit `select()`
 *    column lists (never `select("*")`), a future schema column cannot
 *    silently widen a DTO.
 * 2. **`null` becomes `undefined` before any validation.** Every optional DTO
 *    field is `?: T`, never `| null`. This is load-bearing, not cosmetic:
 *    `getGoals()`'s ordering tests `targetDate === undefined`, and the
 *    fixture-coherence invariant "movement legs never carry a categoryId"
 *    asserts `toBeUndefined()`. A leaked `null` inverts the first and fails
 *    the second. A null is never coerced to `0` (docs/database-schema.md §9).
 * 3. **An `AppError` message names the column, never the value.**
 *    `lib/errors.ts` forbids balances, amounts, merchant names, and row
 *    payloads in `message` because dev forwards `message` to the client. The
 *    original throw travels as `cause`, which stays server-side.
 *
 * The enum label sets `enumFrom()` narrows against live in
 * `lib/types/enums.ts`, not here. Validating untrusted *input*
 * (`lib/validation/**`) needs the same lists, and that layer is fenced off
 * from `lib/data/**` — so the lists sit in the one layer both may import.
 */
import type {
  AccountBalanceRow,
  BillRow,
  BudgetRow,
  CategoryRow,
  GoalBalanceRow,
  NetWorthSnapshotRow,
  TransactionRow,
} from "@/lib/data/rows";
import { dataIntegrity } from "@/lib/errors";
import type {
  Account,
  Bill,
  Budget,
  CalendarDate,
  Category,
  Cents,
  Goal,
  MonthKey,
  NetWorthSnapshot,
  Transaction,
} from "@/lib/types";
import { toCents } from "@/lib/types";
import {
  ACCOUNT_TYPES,
  BILL_FREQUENCIES,
  CATEGORY_KINDS,
  TRANSACTION_KINDS,
} from "@/lib/types/enums";

// ============================================================
// Field validators
// ============================================================

/**
 * A `BIGINT` money column → branded `Cents`.
 *
 * `toCents()` is the only constructor of the brand and already rejects a
 * non-safe integer; this wraps it rather than replacing it, adding the
 * wire-type handling and the error taxonomy. The string branch is defense
 * against a PostgREST/driver configuration that quotes bigints (see
 * `lib/data/rows.ts`) — a quoted value that parses to an unsafe integer still
 * throws rather than truncating.
 */
export function centsFrom(value: unknown, column: string): Cents {
  let numeric: unknown = value;
  if (typeof numeric === "string") {
    // Number("") and Number("  ") are both 0 — an empty column must not
    // silently become a zero balance.
    if (numeric.trim() === "") throw dataIntegrity(`Non-numeric value for ${column}.`);
    numeric = Number(numeric);
  }
  if (typeof numeric !== "number") throw dataIntegrity(`Non-numeric value for ${column}.`);

  try {
    return toCents(numeric);
  } catch (cause) {
    // toCents's own message embeds the value; it stays in `cause`, which is
    // server-side only, and never in the message we construct here.
    throw dataIntegrity(`Invalid cents value for ${column}.`, { cause });
  }
}

/** Nullable money column → `Cents | undefined`. Null resolves before validation. */
export function centsOrUndefined(value: unknown, column: string): Cents | undefined {
  return value === null || value === undefined ? undefined : centsFrom(value, column);
}

/**
 * A plain `INTEGER` column → `number`. Used for `interest_rate_bps`, which is
 * basis points and **not** money: it is validated as an integer and
 * deliberately never branded as `Cents`.
 */
export function integerFrom(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw dataIntegrity(`Invalid integer value for ${column}.`);
  }
  return value;
}

/** Nullable integer column → `number | undefined`. */
export function integerOrUndefined(value: unknown, column: string): number | undefined {
  return value === null || value === undefined ? undefined : integerFrom(value, column);
}

/**
 * A `DATE` column → `CalendarDate`.
 *
 * The shape check is not decoration: every date comparison and bound in this
 * codebase is a lexicographic string comparison, so a value that arrived as a
 * timestamp (or in any other format) would break ordering and range filters
 * silently rather than loudly.
 */
export function calendarDateFrom(value: unknown, column: string): CalendarDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw dataIntegrity(`Invalid calendar date for ${column}.`);
  }
  return value;
}

/** Nullable `DATE` column → `CalendarDate | undefined`. */
export function calendarDateOrUndefined(value: unknown, column: string): CalendarDate | undefined {
  return value === null || value === undefined ? undefined : calendarDateFrom(value, column);
}

/** A 'YYYY-MM' period column → `MonthKey`, matching the schema's CHECK. */
export function monthKeyFrom(value: unknown, column: string): MonthKey {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw dataIntegrity(`Invalid month key for ${column}.`);
  }
  return value;
}

/**
 * A Postgres enum column → the corresponding DTO union member.
 *
 * The wire delivers text, so narrowing is a runtime check, never an assertion.
 * The offending value is not quoted: it is arbitrary database text and the
 * message rule is unconditional.
 */
export function enumFrom<T extends string>(value: unknown, allowed: readonly T[], column: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw dataIntegrity(`Unrecognized value for ${column}.`);
  }
  return value as T;
}

// ============================================================
// Row → DTO
// ============================================================

/** `account_balances` view row → `Account`. `balanceCents` is signed. */
export function toAccount(row: AccountBalanceRow): Account {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: enumFrom(row.type, ACCOUNT_TYPES, "account_balances.type"),
    balanceCents: centsFrom(row.balance_cents, "account_balances.balance_cents"),
    creditLimitCents: centsOrUndefined(row.credit_limit_cents, "account_balances.credit_limit_cents"),
    interestRateBps: integerOrUndefined(row.interest_rate_bps, "account_balances.interest_rate_bps"),
    isArchived: row.is_archived,
  };
}

/**
 * `categories` row → `Category`.
 *
 * `isArchived` is exposed as of Phase 7 CP2. It filters nothing here: archived
 * categories are still returned, because they are what resolves the label on a
 * historical transaction. The flag only tells a caller which of them to keep
 * out of a *new-entry* picker.
 */
export function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    kind: enumFrom(row.kind, CATEGORY_KINDS, "categories.kind"),
    isArchived: row.is_archived,
  };
}

/**
 * `transactions` row → `Transaction`.
 *
 * `created_at` is an ordering key only and is deliberately absent from the DTO.
 * `category_id` and `movement_id` are both legitimately null and become
 * `undefined`.
 */
export function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.account_id,
    date: calendarDateFrom(row.date, "transactions.date"),
    merchant: row.merchant,
    kind: enumFrom(row.kind, TRANSACTION_KINDS, "transactions.kind"),
    categoryId: row.category_id ?? undefined,
    movementId: row.movement_id ?? undefined,
    amountCents: centsFrom(row.amount_cents, "transactions.amount_cents"),
  };
}

/** `budgets` row → `Budget`. */
export function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    categoryId: row.category_id,
    period: monthKeyFrom(row.period, "budgets.period"),
    limitCents: centsFrom(row.limit_cents, "budgets.limit_cents"),
  };
}

/**
 * `bills` row + its projected due date → `Bill`.
 *
 * `dueDate` is a parameter because it is not a column on `bills`: it is the
 * earliest `scheduled` occurrence's `due_date`, resolved by the caller from
 * `bill_occurrences`. It is validated here all the same — this DTO field
 * drives the overdue/due-soon grouping on `/bills`.
 */
export function toBill(row: BillRow, dueDate: unknown): Bill {
  return {
    id: row.id,
    name: row.name,
    amountCents: centsFrom(row.amount_cents, "bills.amount_cents"),
    dueDate: calendarDateFrom(dueDate, "bill_occurrences.due_date"),
    frequency: enumFrom(row.frequency, BILL_FREQUENCIES, "bills.frequency"),
    categoryId: row.category_id ?? undefined,
    accountId: row.account_id ?? undefined,
  };
}

/** `goal_balances` view row → `Goal`. `savedCents` is view-derived. */
export function toGoal(row: GoalBalanceRow): Goal {
  return {
    id: row.id,
    name: row.name,
    targetCents: centsFrom(row.target_cents, "goal_balances.target_cents"),
    savedCents: centsFrom(row.saved_cents, "goal_balances.saved_cents"),
    targetDate: calendarDateOrUndefined(row.target_date, "goal_balances.target_date"),
  };
}

/**
 * `net_worth_snapshots` row → `NetWorthSnapshot`.
 *
 * `netWorthCents` is stored, not implied, so the identity
 * `netWorth === assets - liabilities` is re-checked here rather than assumed.
 * The database has the same CHECK constraint; a row that reached this mapper
 * violating it would mean the stored convention had diverged from the one
 * `lib/finance/**` and the display layer rely on, which must fail loudly.
 */
export function toNetWorthSnapshot(row: NetWorthSnapshotRow): NetWorthSnapshot {
  const assetsCents = centsFrom(row.assets_cents, "net_worth_snapshots.assets_cents");
  const liabilitiesCents = centsFrom(row.liabilities_cents, "net_worth_snapshots.liabilities_cents");
  const netWorthCents = centsFrom(row.net_worth_cents, "net_worth_snapshots.net_worth_cents");

  if (netWorthCents !== assetsCents - liabilitiesCents) {
    throw dataIntegrity("net_worth_snapshots row violates the net worth identity.");
  }

  return {
    month: monthKeyFrom(row.month, "net_worth_snapshots.month"),
    assetsCents,
    liabilitiesCents,
    netWorthCents,
  };
}
