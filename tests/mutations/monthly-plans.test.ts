import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { IDLE, MONTHLY_PLAN_ROUTES, formData } from "./support/mutation-harness";

/**
 * Expected monthly income, end to end: real Server Actions, real validation,
 * real mutation DAL, real production read DAL, real database, RLS on.
 *
 * The claims under test, in the order the blocks run:
 *
 *   1. **Set, change and clear** — and "not set" is a state, distinct from
 *      zero, that clearing actually returns to.
 *   2. **The month is the server's** — derived from `getToday()`, never a
 *      field, so this owner can only ever address their own current month.
 *   3. **Actual income stays derived** — `monthlyIncome()` over real
 *      transactions, never influenced by a target at any value.
 *   4. **A target is not money** — no account balance, no net worth, no
 *      snapshot, no budget, no transaction moves when a plan is written.
 *   5. **Unallocated is expected minus planned**, over real budget rows.
 *
 * `getToday()` is not mocked, so the month under test is the owner's own,
 * computed from `profiles.timezone` exactly as the action computes it.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: "" as string,
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    mocks.revalidated.push(path);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    mocks.redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

const planActions = await import("@/lib/actions/monthly-plans");
const transactionActions = await import("@/lib/actions/transactions");
const budgetActions = await import("@/lib/actions/budgets");
const { getMonthlyPlan } = await import("@/lib/data/monthly-plans");
const { getBudgets } = await import("@/lib/data/budgets");
const { getAccounts } = await import("@/lib/data/accounts");
const { getCategories } = await import("@/lib/data/categories");
const { getTransactions } = await import("@/lib/data/transactions");
const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const { getToday } = await import("@/lib/data/clock");
const { netWorth, totalAssets, totalLiabilities } = await import("@/lib/finance/accounts");
const { monthlyIncome, monthlySpending, monthlyCashFlow } = await import(
  "@/lib/finance/transactions"
);
const { monthlyPlanSummary } = await import("@/lib/finance/planning");
const { monthKey } = await import("@/lib/finance/dates");

let context: Awaited<ReturnType<typeof createMutationContext>>;
let today: string;
let period: string;

beforeAll(async () => {
  context = await createMutationContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
  today = await getToday();
  period = monthKey(today);
}, 30_000);

beforeEach(async () => {
  mocks.revalidated = [];
  mocks.redirectedTo = null;
  // Every block starts from "not set", so no test depends on another's plan.
  await planActions.clearMonthlyPlanAction();
  mocks.revalidated = [];
});

/** The set-expected-income submission a form would post. */
function planFields(expectedIncome: string, id = crypto.randomUUID()) {
  return formData({ id, expectedIncome });
}

/** Every figure a plan write could conceivably move, read through the real DAL. */
async function financialState() {
  const accounts = await getAccounts();
  const transactions = await getTransactions({});
  const history = await getNetWorthHistory(24);
  const budgets = await getBudgets(period);

  return {
    balances: accounts.map((a) => `${a.id}:${a.balanceCents}`).sort(),
    assets: totalAssets(accounts),
    liabilities: totalLiabilities(accounts),
    netWorth: netWorth(accounts),
    income: monthlyIncome(transactions, period),
    spending: monthlySpending(transactions, period),
    cashFlow: monthlyCashFlow(transactions, period),
    transactionCount: transactions.length,
    budgets: budgets.map((b) => `${b.categoryId}:${b.limitCents}`).sort(),
    snapshots: history.map(
      (s) => `${s.month}:${s.netWorthCents}:${s.assetsCents}:${s.liabilitiesCents}`
    ),
  };
}

describe("setMonthlyPlanAction", () => {
  it("creates a plan for the owner's current month", async () => {
    const state = await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));
    expect(state.status, state.formError ?? "").toBe("success");

    const plan = await getMonthlyPlan(period);
    expect(plan).toBeDefined();
    expect(plan!.period).toBe(period);
    expect(plan!.expectedIncomeCents).toBe(400_000);
  });

  it("updates an existing plan rather than creating a second one", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));
    const first = await getMonthlyPlan(period);

    const state = await planActions.setMonthlyPlanAction(IDLE, planFields("4500.00"));
    expect(state.status, state.formError ?? "").toBe("success");

    const second = await getMonthlyPlan(period);
    expect(second!.expectedIncomeCents).toBe(450_000);
    // Same row, edited — not a second one under a new key.
    expect(second!.id).toBe(first!.id);
  });

  it("is idempotent under a resubmitted key", async () => {
    const key = crypto.randomUUID();
    const first = await planActions.setMonthlyPlanAction(IDLE, planFields("1234.56", key));
    const second = await planActions.setMonthlyPlanAction(IDLE, planFields("1234.56", key));

    expect(first.status, first.formError ?? "").toBe("success");
    expect(second.status, second.formError ?? "").toBe("success");
    expect((await getMonthlyPlan(period))!.expectedIncomeCents).toBe(123_456);
  });

  it("accepts zero — 'no income expected' is a real plan, and is not 'not set'", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("0"));

    const plan = await getMonthlyPlan(period);
    expect(plan).toBeDefined();
    expect(plan!.expectedIncomeCents).toBe(0);
  });

  it("rejects a negative figure without writing anything", async () => {
    const state = await planActions.setMonthlyPlanAction(IDLE, planFields("-100.00"));

    expect(state.status).toBe("error");
    expect(await getMonthlyPlan(period)).toBeUndefined();
  });

  it("rejects a third decimal place rather than rounding it away", async () => {
    const state = await planActions.setMonthlyPlanAction(IDLE, planFields("1234.567"));

    expect(state.status).toBe("error");
    expect(state.fieldErrors.expectedIncome?.join(" ")).toMatch(/two decimal places/);
    expect(await getMonthlyPlan(period)).toBeUndefined();
  });

  it("revalidates exactly /budgets", async () => {
    mocks.revalidated = [];
    await planActions.setMonthlyPlanAction(IDLE, planFields("2000.00"));

    expect(mocks.revalidated).toEqual(MONTHLY_PLAN_ROUTES);
  });
});

describe("clearMonthlyPlanAction", () => {
  it("returns the month to 'not set', which is not a zero", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));
    expect(await getMonthlyPlan(period)).toBeDefined();

    mocks.revalidated = [];
    const state = await planActions.clearMonthlyPlanAction();
    expect(state.status, state.formError ?? "").toBe("success");

    // Undefined, not a row holding zero. The summary renders the two
    // differently and the distinction has to survive the round trip.
    expect(await getMonthlyPlan(period)).toBeUndefined();
    expect(mocks.revalidated).toEqual(MONTHLY_PLAN_ROUTES);
  });

  it("is a silent success when there is nothing to clear", async () => {
    const state = await planActions.clearMonthlyPlanAction();
    expect(state.status, state.formError ?? "").toBe("success");
    expect(await getMonthlyPlan(period)).toBeUndefined();
  });
});

describe("month isolation", () => {
  it("reads back under the owner's own month and no other", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("3000.00"));

    expect((await getMonthlyPlan(period))!.expectedIncomeCents).toBe(300_000);
    // Any other month is unaffected — the action never accepted one.
    for (const other of ["2000-01", "2099-12"]) {
      expect(await getMonthlyPlan(other)).toBeUndefined();
    }
  });

  it("ignores a period posted alongside the form", async () => {
    // The action derives the month from `getToday()`; a hand-crafted request
    // naming another one has nothing this layer will read.
    const state = await planActions.setMonthlyPlanAction(
      IDLE,
      formData({ id: crypto.randomUUID(), expectedIncome: "1500.00", period: "2000-01" })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    expect((await getMonthlyPlan(period))!.expectedIncomeCents).toBe(150_000);
    expect(await getMonthlyPlan("2000-01")).toBeUndefined();
  });
});

describe("a target is not money", () => {
  it("moves no balance, no net worth, no snapshot, no budget and no transaction", async () => {
    const before = await financialState();

    for (const amount of ["4000.00", "0", "12345.67"]) {
      await planActions.setMonthlyPlanAction(IDLE, planFields(amount));
      expect(await financialState()).toEqual(before);
    }

    await planActions.clearMonthlyPlanAction();
    expect(await financialState()).toEqual(before);
  }, 60_000);

  it("never becomes actual income, at any value", async () => {
    const transactions = await getTransactions({});
    const actualBefore = monthlyIncome(transactions, period);

    for (const amount of ["999999.00", "0"]) {
      await planActions.setMonthlyPlanAction(IDLE, planFields(amount));
      const after = monthlyIncome(await getTransactions({}), period);
      expect(after).toBe(actualBefore);
    }
  });

  it("tracks real income as it is recorded, independently of the target", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));

    const account = (await getAccounts()).find((a) => !a.isArchived)!;
    const incomeCategory = (await getCategories()).find(
      (c) => c.kind === "income" && !c.isArchived
    )!;

    const before = monthlyIncome(await getTransactions({}), period);

    const transactionId = crypto.randomUUID();
    const created = await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "P8 Plan salary",
        kind: "income",
        categoryId: incomeCategory.id,
        amount: "1200.00",
      })
    );
    expect(created.status, created.formError ?? "").toBe("success");

    const after = monthlyIncome(await getTransactions({}), period);
    expect(after).toBe(before + 120_000);

    // The plan itself did not move.
    expect((await getMonthlyPlan(period))!.expectedIncomeCents).toBe(400_000);

    await transactionActions.deleteTransactionAction(IDLE, formData({ id: transactionId }));
  });
});

describe("the summary the page renders", () => {
  it("computes unallocated as expected income minus every budget limit for the month", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));

    const budgets = await getBudgets(period);
    const transactions = await getTransactions({ month: period });
    const plan = await getMonthlyPlan(period);
    const summary = monthlyPlanSummary(plan, budgets, transactions, period);

    const plannedTotal = budgets.reduce((total, budget) => total + budget.limitCents, 0);
    expect(summary.plannedExpensesCents).toBe(plannedTotal);
    expect(summary.expectedIncomeCents).toBe(400_000);
    expect(summary.unallocatedCents).toBe(400_000 - plannedTotal);
  });

  it("follows a new budget into the planned total, and back out again", async () => {
    await planActions.setMonthlyPlanAction(IDLE, planFields("4000.00"));

    const summaryNow = async () =>
      monthlyPlanSummary(
        await getMonthlyPlan(period),
        await getBudgets(period),
        await getTransactions({ month: period }),
        period
      );

    const before = await summaryNow();

    // Any active expense category that has no budget this month yet.
    const budgeted = new Set((await getBudgets(period)).map((b) => b.categoryId));
    const category = (await getCategories()).find(
      (c) => c.kind === "expense" && !c.isArchived && !budgeted.has(c.id)
    );
    if (category === undefined) return; // nothing left to budget — nothing to prove here

    const budgetId = crypto.randomUUID();
    const created = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: budgetId, categoryId: category.id, limit: "150.00" })
    );
    expect(created.status, created.formError ?? "").toBe("success");

    const during = await summaryNow();
    expect(during.plannedExpensesCents).toBe(before.plannedExpensesCents + 15_000);
    expect(during.unallocatedCents).toBe(before.unallocatedCents! - 15_000);
    // The actual side did not move — a budget is a plan, not a payment.
    expect(during.actualIncomeCents).toBe(before.actualIncomeCents);
    expect(during.actualSpendingCents).toBe(before.actualSpendingCents);

    await budgetActions.deleteBudgetAction(IDLE, formData({ id: budgetId }));
    expect(await summaryNow()).toEqual(before);
  }, 60_000);

  it("reports the planned side as unset with no plan, while the actual side stays real", async () => {
    const summary = monthlyPlanSummary(
      await getMonthlyPlan(period),
      await getBudgets(period),
      await getTransactions({ month: period }),
      period
    );

    expect(summary.expectedIncomeCents).toBeUndefined();
    expect(summary.unallocatedCents).toBeUndefined();
    expect(summary.incomeProgress).toBeNull();
    // The actuals are still derived from real rows.
    expect(summary.actualIncomeCents).toBe(
      monthlyIncome(await getTransactions({ month: period }), period)
    );
    expect(summary.actualSpendingCents).toBe(
      monthlySpending(await getTransactions({ month: period }), period)
    );
    expect(summary.actualCashFlowCents).toBe(
      monthlyCashFlow(await getTransactions({ month: period }), period)
    );
  });
});
