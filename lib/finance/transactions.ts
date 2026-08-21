import { monthKey } from "@/lib/finance/dates";
import { percentage, sumCents } from "@/lib/finance/money";
import { toCents, type Cents, type MonthKey, type Transaction } from "@/lib/types";

/**
 * `transfer` and `credit_card_payment` move money between two owned
 * accounts — they are never spending, regardless of amount or sign.
 */
export function countsAsSpending(transaction: Transaction): boolean {
  return transaction.kind === "expense" || transaction.kind === "refund";
}

/** A refund is not income — it only reduces its category's spend. */
export function countsAsIncome(transaction: Transaction): boolean {
  return transaction.kind === "income";
}

function inMonth(transaction: Transaction, month: MonthKey): boolean {
  return monthKey(transaction.date) === month;
}

export function monthlyIncome(transactions: readonly Transaction[], month: MonthKey): Cents {
  return sumCents(
    transactions.filter((t) => countsAsIncome(t) && inMonth(t, month)).map((t) => t.amountCents)
  );
}

/**
 * Positive display magnitude: expenses are stored negative, so the signed
 * sum is negated. A category that was refunded more than it was spent in
 * the same month legitimately returns a negative value here — that is not
 * clamped away, since it is a real "net refunded" state, not an error.
 */
export function monthlySpending(transactions: readonly Transaction[], month: MonthKey): Cents {
  const netSigned = sumCents(
    transactions.filter((t) => countsAsSpending(t) && inMonth(t, month)).map((t) => t.amountCents)
  );
  return toCents(-netSigned || 0); // avoid -0 for a month with no spending
}

/** Economic income minus economic spending (both already correctly signed/magnituded). */
export function monthlyCashFlow(transactions: readonly Transaction[], month: MonthKey): Cents {
  return toCents(monthlyIncome(transactions, month) - monthlySpending(transactions, month));
}

/** Cash flow as a percentage of income. null when income is 0 (never NaN/Infinity). */
export function savingsRate(transactions: readonly Transaction[], month: MonthKey): number | null {
  const income = monthlyIncome(transactions, month);
  return percentage(monthlyCashFlow(transactions, month), income);
}

export interface CategorySpend {
  categoryId: string;
  /** Positive magnitude; negative means net refunded that category that month. */
  amountCents: Cents;
}

/** Movement legs never have a categoryId and are excluded by `countsAsSpending` regardless. */
export function spendingByCategory(
  transactions: readonly Transaction[],
  month: MonthKey
): CategorySpend[] {
  const totals = new Map<string, number>();
  for (const t of transactions) {
    if (!countsAsSpending(t) || !inMonth(t, month) || t.categoryId === undefined) continue;
    totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amountCents);
  }
  return Array.from(totals.entries()).map(([categoryId, netSigned]) => ({
    categoryId,
    amountCents: toCents(-netSigned || 0), // avoid -0 when a category nets to exactly zero
  }));
}
