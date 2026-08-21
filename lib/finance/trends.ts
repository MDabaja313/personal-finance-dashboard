import { monthlyCashFlow, monthlyIncome, monthlySpending, savingsRate } from "@/lib/finance/transactions";
import type { Cents, MonthKey, Transaction } from "@/lib/types";

export interface MonthlyTotal {
  month: MonthKey;
  incomeCents: Cents;
  spendingCents: Cents;
  cashFlowCents: Cents;
  savingsRate: number | null;
}

/**
 * One row per requested month, in the given order — a month with no
 * transactions still appears, with zeroed totals, rather than being
 * silently dropped from a trend chart.
 */
export function monthlyTotals(
  transactions: readonly Transaction[],
  months: readonly MonthKey[]
): MonthlyTotal[] {
  return months.map((month) => ({
    month,
    incomeCents: monthlyIncome(transactions, month),
    spendingCents: monthlySpending(transactions, month),
    cashFlowCents: monthlyCashFlow(transactions, month),
    savingsRate: savingsRate(transactions, month),
  }));
}
