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

export type AccountType = "checking" | "savings" | "credit" | "investment" | "cash";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  balanceCents: Cents;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: CalendarDate;
  description: string;
  category: string;
  /** Signed: negative = money out, positive = money in (e.g. a refund). */
  amountCents: Cents;
}

export interface Budget {
  id: string;
  category: string;
  /** 'YYYY-MM' */
  period: string;
  limitCents: Cents;
  spentCents: Cents;
}

export interface Bill {
  id: string;
  name: string;
  amountCents: Cents;
  dueDate: CalendarDate;
  isPaid: boolean;
}

export interface Goal {
  id: string;
  name: string;
  targetCents: Cents;
  savedCents: Cents;
  targetDate?: CalendarDate;
}

export interface Category {
  id: string;
  name: string;
  kind: "income" | "expense";
}
