import { describe, expect, it } from "vitest";

import { monthlyPlanSummary } from "@/lib/finance/planning";
import { monthlyIncome, monthlySpending } from "@/lib/finance/transactions";
import { toCents, type Budget, type MonthlyPlan, type Transaction } from "@/lib/types";

/**
 * The Monthly Plan calculation.
 *
 * Two properties matter more than the arithmetic, and each has its own block
 * below:
 *
 * 1. **A plan is a target and never becomes an actual.** No expected figure
 *    reaches income, spending or cash flow, in any combination.
 * 2. **"Not set" is not zero.** An absent plan leaves the planned side
 *    undefined rather than reporting every budgeted pound as over-allocated.
 */

const MONTH = "2026-08";
const OTHER_MONTH = "2026-07";

function plan(expectedIncomeCents: number): MonthlyPlan {
  return { id: "plan-1", period: MONTH, expectedIncomeCents: toCents(expectedIncomeCents) };
}

function budget(id: string, categoryId: string, limitCents: number): Budget {
  return { id, categoryId, period: MONTH, limitCents: toCents(limitCents) };
}

let sequence = 0;
function txn(
  kind: Transaction["kind"],
  amountCents: number,
  date = `${MONTH}-15`,
  categoryId?: string
): Transaction {
  sequence += 1;
  return {
    id: `t-${sequence}`,
    accountId: "acct-1",
    date,
    merchant: "Merchant",
    kind,
    categoryId,
    amountCents: toCents(amountCents),
  };
}

describe("monthlyPlanSummary — the planned side", () => {
  it("sums every budget limit into planned expenses", () => {
    const summary = monthlyPlanSummary(
      plan(400_000),
      [budget("b1", "c1", 120_000), budget("b2", "c2", 200_000)],
      [],
      MONTH
    );

    expect(summary.plannedExpensesCents).toBe(320_000);
  });

  it("computes unallocated as expected income minus planned expenses", () => {
    // The worked example from the feature request: 4,000 expected, 3,200
    // planned, 800 unallocated.
    const summary = monthlyPlanSummary(
      plan(400_000),
      [budget("b1", "c1", 120_000), budget("b2", "c2", 200_000)],
      [],
      MONTH
    );

    expect(summary.expectedIncomeCents).toBe(400_000);
    expect(summary.unallocatedCents).toBe(80_000);
  });

  it("reports a negative unallocated rather than clamping it — over-allocation is real", () => {
    const summary = monthlyPlanSummary(plan(100_000), [budget("b1", "c1", 150_000)], [], MONTH);

    expect(summary.unallocatedCents).toBe(-50_000);
    expect(summary.allocationRate).toBe(150);
  });

  it("never produces a negative zero", () => {
    const summary = monthlyPlanSummary(plan(100_000), [budget("b1", "c1", 100_000)], [], MONTH);

    expect(summary.unallocatedCents).toBe(0);
    expect(Object.is(summary.unallocatedCents, -0)).toBe(false);
    expect(JSON.stringify(summary.unallocatedCents)).toBe("0");
  });

  it("treats zero planned expenses as zero, not as absent", () => {
    const summary = monthlyPlanSummary(plan(400_000), [], [], MONTH);

    expect(summary.plannedExpensesCents).toBe(0);
    expect(summary.unallocatedCents).toBe(400_000);
  });
});

describe("monthlyPlanSummary — 'not set' is not zero", () => {
  it("leaves expected income, unallocated and both rates undefined or null with no plan", () => {
    const summary = monthlyPlanSummary(undefined, [budget("b1", "c1", 150_000)], [], MONTH);

    expect(summary.expectedIncomeCents).toBeUndefined();
    expect(summary.unallocatedCents).toBeUndefined();
    expect(summary.incomeProgress).toBeNull();
    expect(summary.allocationRate).toBeNull();
    // The planned total is still a real figure — it comes from budgets, which
    // exist whether or not an income target does.
    expect(summary.plannedExpensesCents).toBe(150_000);
  });

  it("distinguishes an absent plan from a plan of exactly zero", () => {
    const absent = monthlyPlanSummary(undefined, [budget("b1", "c1", 150_000)], [], MONTH);
    const zero = monthlyPlanSummary(plan(0), [budget("b1", "c1", 150_000)], [], MONTH);

    expect(absent.unallocatedCents).toBeUndefined();
    // Zero expected income makes every budgeted pound unallocated, which is a
    // real answer to a question that has been asked.
    expect(zero.unallocatedCents).toBe(-150_000);
    // A zero denominator still renders as "—" rather than as Infinity.
    expect(zero.allocationRate).toBeNull();
    expect(zero.incomeProgress).toBeNull();
  });
});

describe("monthlyPlanSummary — actuals come from transactions, never from the plan", () => {
  it("derives income and spending from real transactions", () => {
    const transactions = [
      txn("income", 200_000),
      txn("expense", -80_000, `${MONTH}-03`, "c1"),
      txn("expense", -30_000, `${MONTH}-09`, "c2"),
    ];

    const summary = monthlyPlanSummary(plan(400_000), [], transactions, MONTH);

    expect(summary.actualIncomeCents).toBe(200_000);
    expect(summary.actualSpendingCents).toBe(110_000);
    expect(summary.actualCashFlowCents).toBe(90_000);
  });

  it("agrees exactly with lib/finance/transactions.ts rather than re-deriving", () => {
    // The point of the assertion is the *identity*: if this ever drifted, the
    // Monthly Plan card and the dashboard would report different incomes for
    // the same month.
    const transactions = [
      txn("income", 500_00),
      txn("refund", 25_00, `${MONTH}-04`, "c1"),
      txn("expense", -75_00, `${MONTH}-05`, "c1"),
      txn("transfer", -100_00),
      txn("adjustment", 900_00),
    ];

    const summary = monthlyPlanSummary(plan(1000_00), [], transactions, MONTH);

    expect(summary.actualIncomeCents).toBe(monthlyIncome(transactions, MONTH));
    expect(summary.actualSpendingCents).toBe(monthlySpending(transactions, MONTH));
  });

  it("excludes transfers, card payments and adjustments from every actual", () => {
    // A movement leg and an adjustment move a balance without being economic
    // events. The plan summary inherits that from the three authorities it
    // calls, and this pins it.
    const transactions = [
      txn("transfer", -100_000),
      txn("credit_card_payment", 100_000),
      txn("adjustment", 250_000),
      txn("adjustment", -40_000),
    ];

    const summary = monthlyPlanSummary(plan(400_000), [], transactions, MONTH);

    expect(summary.actualIncomeCents).toBe(0);
    expect(summary.actualSpendingCents).toBe(0);
    expect(summary.actualCashFlowCents).toBe(0);
  });

  it("ignores transactions from other months", () => {
    const transactions = [txn("income", 999_000, `${OTHER_MONTH}-15`)];

    const summary = monthlyPlanSummary(plan(400_000), [], transactions, MONTH);

    expect(summary.actualIncomeCents).toBe(0);
  });

  it("does not let expected income change any actual, at any value", () => {
    const transactions = [txn("income", 123_400), txn("expense", -45_600, `${MONTH}-06`, "c1")];
    const baseline = monthlyPlanSummary(undefined, [], transactions, MONTH);

    for (const expected of [0, 1, 400_000, 9_000_000]) {
      const withPlan = monthlyPlanSummary(plan(expected), [], transactions, MONTH);
      expect(withPlan.actualIncomeCents).toBe(baseline.actualIncomeCents);
      expect(withPlan.actualSpendingCents).toBe(baseline.actualSpendingCents);
      expect(withPlan.actualCashFlowCents).toBe(baseline.actualCashFlowCents);
    }
  });

  it("does not let a budget limit change any actual either", () => {
    const transactions = [txn("expense", -45_600, `${MONTH}-06`, "c1")];
    const baseline = monthlyPlanSummary(plan(400_000), [], transactions, MONTH);
    const budgeted = monthlyPlanSummary(
      plan(400_000),
      [budget("b1", "c1", 999_999)],
      transactions,
      MONTH
    );

    expect(budgeted.actualSpendingCents).toBe(baseline.actualSpendingCents);
    expect(budgeted.actualCashFlowCents).toBe(baseline.actualCashFlowCents);
  });
});

describe("monthlyPlanSummary — the two percentages", () => {
  it("reports income progress against the target, over 100 included", () => {
    const summary = monthlyPlanSummary(plan(200_000), [], [txn("income", 300_000)], MONTH);

    expect(summary.incomeProgress).toBe(150);
  });

  it("reports zero progress for a month with no income yet", () => {
    const summary = monthlyPlanSummary(plan(200_000), [], [], MONTH);

    expect(summary.incomeProgress).toBe(0);
  });

  it("carries the requested period through untouched", () => {
    expect(monthlyPlanSummary(undefined, [], [], MONTH).period).toBe(MONTH);
  });
});
