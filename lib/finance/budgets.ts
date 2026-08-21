import { percentage } from "@/lib/finance/money";
import { spendingByCategory } from "@/lib/finance/transactions";
import { toCents, type Budget, type Cents, type Transaction } from "@/lib/types";

export interface BudgetStatus {
  budget: Budget;
  spentCents: Cents;
  remainingCents: Cents;
  /** Percentage of the limit spent. May exceed 100 when over budget; null when the limit is 0. */
  utilization: number | null;
  isOverBudget: boolean;
}

/**
 * `spent` is computed from transactions, never stored — a stored figure
 * could silently disagree with the transaction list it's supposed to
 * summarize.
 */
export function budgetStatus(budget: Budget, transactions: readonly Transaction[]): BudgetStatus {
  const spentCents =
    spendingByCategory(transactions, budget.period).find(
      (c) => c.categoryId === budget.categoryId
    )?.amountCents ?? toCents(0);

  return {
    budget,
    spentCents,
    remainingCents: toCents(budget.limitCents - spentCents),
    utilization: percentage(spentCents, budget.limitCents),
    isOverBudget: spentCents > budget.limitCents,
  };
}
