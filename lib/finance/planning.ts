import { percentage, sumCents } from "@/lib/finance/money";
import { monthlyCashFlow, monthlyIncome, monthlySpending } from "@/lib/finance/transactions";
import { toCents, type Budget, type Cents, type MonthKey, type MonthlyPlan, type Transaction } from "@/lib/types";

/**
 * The Monthly Plan summary — one month's intent beside the same month's
 * reality.
 *
 * Pure, like everything in `lib/finance/**`: no DAL, no clock, no React. The
 * month is an explicit parameter, and both the plan and the budgets are handed
 * in already scoped to it.
 *
 * ## Nothing here re-derives an actual
 *
 * `actualIncomeCents`, `actualSpendingCents` and `actualCashFlowCents` come
 * from `monthlyIncome`, `monthlySpending` and `monthlyCashFlow` in
 * `lib/finance/transactions.ts` — called, never reimplemented. Those three are
 * the one authority for what a month actually did, they read `kind` allowlists
 * (so movement legs and adjustments stay excluded), and a second implementation
 * here would be a second answer to the same question.
 *
 * `expectedIncomeCents` cannot influence any of them: it is not a transaction,
 * it has no account and no date, and it reaches none of the three functions
 * above. A target is never an actual, in either direction.
 */
export interface MonthlyPlanSummary {
  readonly period: MonthKey;
  /**
   * What the owner expects to earn this month, or `undefined` when no plan has
   * been set. Never defaulted to zero — see `lib/data/monthly-plans.ts`.
   */
  readonly expectedIncomeCents?: Cents;
  /** The sum of every category budget limit for this month. Always defined; zero with no budgets. */
  readonly plannedExpensesCents: Cents;
  /**
   * `expectedIncome − plannedExpenses`, or `undefined` when no expected income
   * has been set.
   *
   * Signed on purpose, and negative is a real and useful state: it means the
   * category budgets add up to more than the month expects to earn, which is
   * exactly what a planning summary exists to surface. It is never clamped.
   */
  readonly unallocatedCents?: Cents;
  /** Derived from real `income` transactions only. */
  readonly actualIncomeCents: Cents;
  /** Positive display magnitude, from real `expense`/`refund` transactions only. */
  readonly actualSpendingCents: Cents;
  /** `actualIncome − actualSpending`. Signed. */
  readonly actualCashFlowCents: Cents;
  /**
   * Actual income as a percentage of expected. `null` when no plan is set or
   * the expected figure is zero — render as "—", never as NaN or Infinity. May
   * exceed 100 when a month earns more than it planned to, which is not an
   * error and is not clamped.
   */
  readonly incomeProgress: number | null;
  /**
   * Planned expenses as a percentage of expected income. `null` on the same
   * terms. May exceed 100 — that is the over-allocated case above.
   */
  readonly allocationRate: number | null;
}

/**
 * Builds the summary for one month.
 *
 * `budgets` must already be this month's; the period is not re-filtered here,
 * for the reason `budgetStatus()` does not re-filter either — `getBudgets()`
 * takes a period and returns exactly that month's rows, and a defensive filter
 * in the calculation layer would quietly hide a caller that passed the wrong
 * set.
 *
 * `transactions` may span any range: the three actuals filter by month
 * themselves, exactly as every other consumer of them relies on.
 */
export function monthlyPlanSummary(
  plan: MonthlyPlan | undefined,
  budgets: readonly Budget[],
  transactions: readonly Transaction[],
  period: MonthKey
): MonthlyPlanSummary {
  const expectedIncomeCents = plan?.expectedIncomeCents;
  const plannedExpensesCents = sumCents(budgets.map((budget) => budget.limitCents));

  const actualIncomeCents = monthlyIncome(transactions, period);
  const actualSpendingCents = monthlySpending(transactions, period);
  const actualCashFlowCents = monthlyCashFlow(transactions, period);

  // `-0` is normalized away for the same reason `monthlySpending` does it: it
  // is `=== 0` but stringifies as "-0" and survives into JSON.
  const unallocatedCents =
    expectedIncomeCents === undefined
      ? undefined
      : toCents(expectedIncomeCents - plannedExpensesCents || 0);

  return {
    period,
    expectedIncomeCents,
    plannedExpensesCents,
    unallocatedCents,
    actualIncomeCents,
    actualSpendingCents,
    actualCashFlowCents,
    incomeProgress:
      expectedIncomeCents === undefined ? null : percentage(actualIncomeCents, expectedIncomeCents),
    allocationRate:
      expectedIncomeCents === undefined
        ? null
        : percentage(plannedExpensesCents, expectedIncomeCents),
  };
}
