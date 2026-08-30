import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { BUDGET_ROUTES, IDLE, formData } from "./support/mutation-harness";

/**
 * Budget writes, end to end — the same arrangement as `accounts.test.ts` and
 * `categories.test.ts`: real Server Actions, real validation, real mutation
 * DAL, real local Supabase with RLS on, read back through the real
 * production read DAL.
 *
 * Every category this file budgets is created fresh through the real
 * category action rather than borrowed from the seed, so these tests never
 * depend on which month the seed's fixed '2026-08' budgets happen to still
 * be current for — the current month is read from the real `getToday()`,
 * exactly as `createBudgetAction` itself derives it.
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

const budgetActions = await import("@/lib/actions/budgets");
const categoryActions = await import("@/lib/actions/categories");
const { getBudgets } = await import("@/lib/data/budgets");
const { getCategories } = await import("@/lib/data/categories");
const { getToday } = await import("@/lib/data/clock");
const { monthKey } = await import("@/lib/finance/dates");

let context: Awaited<ReturnType<typeof createMutationContext>>;
let currentPeriod: string;

beforeAll(async () => {
  context = await createMutationContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
  currentPeriod = monthKey(await getToday());
}, 30_000);

beforeEach(() => {
  mocks.revalidated = [];
  mocks.redirectedTo = null;
});

/** Creates a fresh, active, unbudgeted expense category through the real action. */
async function createExpenseCategory(name: string): Promise<string> {
  const state = await categoryActions.createCategoryAction(
    IDLE,
    formData({ name, kind: "expense" })
  );
  expect(state.status, state.formError ?? "").toBe("success");
  const category = (await getCategories()).find((c) => c.name === name);
  expect(category).toBeDefined();
  return category!.id;
}

/** The budget for this category in the current period, read back through the production DAL. */
async function readBudget(categoryId: string) {
  return (await getBudgets(currentPeriod)).find((b) => b.categoryId === categoryId);
}

describe("createBudgetAction", () => {
  it("creates a current-month budget for an active expense category", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category A");

    const id = crypto.randomUUID();
    const state = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id, categoryId, limit: "500.00" })
    );

    expect(state.status, state.formError ?? "").toBe("success");
    const budget = await readBudget(categoryId);
    expect(budget).toBeDefined();
    expect(budget!.id).toBe(id);
    expect(budget!.period).toBe(currentPeriod);
    expect(budget!.limitCents).toBe(50000);
  });

  it("revalidates exactly the budget routes on success", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category B");
    mocks.revalidated = [];

    await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId, limit: "10.00" })
    );

    expect(mocks.revalidated).toEqual(BUDGET_ROUTES);
    expect(mocks.redirectedTo).toBeNull();
  });

  it("treats an exact retry under the same id as a successful no-op", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category C");
    const id = crypto.randomUUID();
    const fields = { id, categoryId, limit: "75.00" };

    const first = await budgetActions.createBudgetAction(IDLE, formData(fields));
    expect(first.status).toBe("success");

    mocks.revalidated = [];
    const retry = await budgetActions.createBudgetAction(IDLE, formData(fields));
    expect(retry.status, retry.formError ?? "").toBe("success");

    const budgets = (await getBudgets(currentPeriod)).filter((b) => b.categoryId === categoryId);
    expect(budgets).toHaveLength(1);
  });

  it("reports a conflict when the same id is resubmitted with a different payload", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category D");
    const id = crypto.randomUUID();

    const first = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id, categoryId, limit: "20.00" })
    );
    expect(first.status).toBe("success");

    const conflicting = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id, categoryId, limit: "99.00" })
    );

    expect(conflicting.status).toBe("error");
    expect((await readBudget(categoryId))!.limitCents).toBe(2000);
  });

  it("reports a conflict for a second budget on the same category and month", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category E");

    const first = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId, limit: "30.00" })
    );
    expect(first.status).toBe("success");

    const second = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId, limit: "40.00" })
    );

    expect(second.status).toBe("error");
    const budgets = (await getBudgets(currentPeriod)).filter((b) => b.categoryId === categoryId);
    expect(budgets).toHaveLength(1);
    expect(budgets[0].limitCents).toBe(3000);
  });

  it("refuses an archived category", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category F");
    const archive = await categoryActions.setCategoryArchivedAction(
      IDLE,
      formData({ id: categoryId, archived: "true" })
    );
    expect(archive.status).toBe("success");

    const state = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId, limit: "10.00" })
    );

    expect(state.status).toBe("error");
    expect(await readBudget(categoryId)).toBeUndefined();
  });

  it("refuses an income category", async () => {
    const state1 = await categoryActions.createCategoryAction(
      IDLE,
      formData({ name: "CP6 Budget Income Category", kind: "income" })
    );
    expect(state1.status).toBe("success");
    const categoryId = (await getCategories()).find((c) => c.name === "CP6 Budget Income Category")!
      .id;

    const state = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId, limit: "10.00" })
    );

    expect(state.status).toBe("error");
    expect(await readBudget(categoryId)).toBeUndefined();
  });

  it("rejects a blank category and writes nothing", async () => {
    const state = await budgetActions.createBudgetAction(
      IDLE,
      formData({ id: crypto.randomUUID(), categoryId: "", limit: "10.00" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.categoryId).toBeDefined();
    expect(mocks.revalidated).toEqual([]);
  });
});

describe("updateBudgetAction", () => {
  it("edits the limit and nothing else", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category G");
    const id = crypto.randomUUID();
    await budgetActions.createBudgetAction(IDLE, formData({ id, categoryId, limit: "10.00" }));
    mocks.revalidated = [];

    const state = await budgetActions.updateBudgetAction(IDLE, formData({ id, limit: "25.50" }));

    expect(state.status, state.formError ?? "").toBe("success");
    expect(mocks.revalidated).toEqual(BUDGET_ROUTES);
    const budget = await readBudget(categoryId);
    expect(budget!.limitCents).toBe(2550);
    expect(budget!.categoryId).toBe(categoryId);
    expect(budget!.period).toBe(currentPeriod);
  });

  it("reports a clean not-found for an id the owner does not have", async () => {
    const state = await budgetActions.updateBudgetAction(
      IDLE,
      formData({ id: "00000000-0000-4000-8000-000000000000", limit: "10.00" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

describe("deleteBudgetAction", () => {
  it("deletes an owned budget", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category H");
    const id = crypto.randomUUID();
    await budgetActions.createBudgetAction(IDLE, formData({ id, categoryId, limit: "10.00" }));
    mocks.revalidated = [];

    const state = await budgetActions.deleteBudgetAction(IDLE, formData({ id }));

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(BUDGET_ROUTES);
    expect(await readBudget(categoryId)).toBeUndefined();
  });

  it("reports a clean not-found for an already-deleted budget", async () => {
    const categoryId = await createExpenseCategory("CP6 Budget Category I");
    const id = crypto.randomUUID();
    await budgetActions.createBudgetAction(IDLE, formData({ id, categoryId, limit: "10.00" }));
    await budgetActions.deleteBudgetAction(IDLE, formData({ id }));

    const state = await budgetActions.deleteBudgetAction(IDLE, formData({ id }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

describe("budget writes affect no other financial domain", () => {
  it("changes no account balance and no transaction row", async () => {
    const { getAccounts } = await import("@/lib/data/accounts");
    const before = await getAccounts();

    const categoryId = await createExpenseCategory("CP6 Budget Isolation Category");
    const id = crypto.randomUUID();
    await budgetActions.createBudgetAction(IDLE, formData({ id, categoryId, limit: "999.00" }));
    await budgetActions.updateBudgetAction(IDLE, formData({ id, limit: "1.00" }));
    await budgetActions.deleteBudgetAction(IDLE, formData({ id }));

    const after = await getAccounts();
    expect(after).toEqual(before);
  });
});
