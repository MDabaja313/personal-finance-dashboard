import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { GOAL_ROUTES, IDLE, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Goal and goal-contribution writes, end to end — the same arrangement as
 * every other CP2–CP5 mutation suite: real Server Actions, real validation,
 * real mutation DAL, real local Supabase with RLS on, read back through the
 * real production read DAL.
 *
 * Goals and contributions share one file, the same way reconciliation and
 * adjustment-deletion share `reconciliation.test.ts`: a contribution cannot
 * be tested without a goal to attach it to, and the two domains' finance-
 * isolation proof (no account/transaction/snapshot side effect) is the same
 * proof for both.
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

const goalActions = await import("@/lib/actions/goals");
const contributionActions = await import("@/lib/actions/goal-contributions");
const { getGoalContributions, getGoalsForManagement } = await import("@/lib/data/goals");
const { getToday } = await import("@/lib/data/clock");

let context: Awaited<ReturnType<typeof createMutationContext>>;
let today: string;

beforeAll(async () => {
  context = await createMutationContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
  today = await getToday();
}, 30_000);

beforeEach(() => {
  mocks.revalidated = [];
  mocks.redirectedTo = null;
});

async function readGoal(name: string) {
  return (await getGoalsForManagement()).find((g) => g.name === name);
}

/** Creates a goal through the real action and returns the stored row. */
async function createGoal(name: string, targetCents = 100000) {
  const id = crypto.randomUUID();
  const state = await goalActions.createGoalAction(
    IDLE,
    formData({ id, name, target: (targetCents / 100).toFixed(2), targetDate: "" })
  );
  expect(state.status, state.formError ?? "").toBe("success");
  const created = await readGoal(name);
  expect(created).toBeDefined();
  return created!;
}

describe("createGoalAction", () => {
  it("creates a goal visible through the production read DAL", async () => {
    const goal = await createGoal("CP6 Goal A", 500000);
    expect(goal.targetCents).toBe(500000);
    expect(goal.savedCents).toBe(0);
    expect(goal.isArchived).toBe(false);
  });

  it("revalidates exactly the goal routes on success", async () => {
    await createGoal("CP6 Goal B");
    expect(mocks.revalidated).toEqual(GOAL_ROUTES);
    expect(mocks.redirectedTo).toBeNull();
  });

  it("treats an exact retry under the same id as a successful no-op", async () => {
    const id = crypto.randomUUID();
    const fields = { id, name: "CP6 Goal Retry", target: "100.00", targetDate: "" };

    const first = await goalActions.createGoalAction(IDLE, formData(fields));
    expect(first.status).toBe("success");
    const retry = await goalActions.createGoalAction(IDLE, formData(fields));
    expect(retry.status, retry.formError ?? "").toBe("success");

    const matches = (await getGoalsForManagement()).filter((g) => g.name === "CP6 Goal Retry");
    expect(matches).toHaveLength(1);
  });

  it("reports a conflict when the same id is resubmitted with a different payload", async () => {
    const id = crypto.randomUUID();
    await goalActions.createGoalAction(
      IDLE,
      formData({ id, name: "CP6 Goal Conflict", target: "100.00", targetDate: "" })
    );

    const conflicting = await goalActions.createGoalAction(
      IDLE,
      formData({ id, name: "CP6 Goal Conflict", target: "200.00", targetDate: "" })
    );

    expect(conflicting.status).toBe("error");
  });

  it("rejects a non-positive target and writes nothing", async () => {
    const state = await goalActions.createGoalAction(
      IDLE,
      formData({ id: crypto.randomUUID(), name: "CP6 Bad Goal", target: "0", targetDate: "" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.target).toBeDefined();
    expect(await readGoal("CP6 Bad Goal")).toBeUndefined();
  });
});

describe("updateGoalAction", () => {
  it("edits name, target, and target date", async () => {
    const goal = await createGoal("CP6 Goal Editable");
    mocks.revalidated = [];

    const state = await goalActions.updateGoalAction(
      IDLE,
      formData({ id: goal.id, name: "CP6 Goal Edited", target: "250.00", targetDate: "2030-01-15" })
    );

    expect(state.status, state.formError ?? "").toBe("success");
    expect(mocks.revalidated).toEqual(GOAL_ROUTES);
    const edited = await readGoal("CP6 Goal Edited");
    expect(edited!.id).toBe(goal.id);
    expect(edited!.targetCents).toBe(25000);
    expect(edited!.targetDate).toBe("2030-01-15");
  });

  it("allows the target to be edited below the amount already saved", async () => {
    const goal = await createGoal("CP6 Goal Overfund Target", 100000);
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "900.00", occurredOn: today, note: "" })
    );

    const state = await goalActions.updateGoalAction(
      IDLE,
      formData({ id: goal.id, name: "CP6 Goal Overfund Target", target: "1.00", targetDate: "" })
    );

    expect(state.status).toBe("success");
    const edited = await readGoal("CP6 Goal Overfund Target");
    expect(edited!.targetCents).toBe(100);
    expect(edited!.savedCents).toBe(90000);
  });
});

describe("setGoalArchivedAction", () => {
  it("archives and unarchives, retaining the saved amount throughout", async () => {
    const goal = await createGoal("CP6 Goal Archivable");
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "50.00", occurredOn: today, note: "" })
    );
    mocks.revalidated = [];

    const archived = await goalActions.setGoalArchivedAction(
      IDLE,
      formData({ id: goal.id, archived: "true" })
    );
    expect(archived.status).toBe("success");
    expect(mocks.revalidated).toEqual(GOAL_ROUTES);

    const whileArchived = await readGoal("CP6 Goal Archivable");
    expect(whileArchived!.isArchived).toBe(true);
    expect(whileArchived!.savedCents).toBe(5000);

    const unarchived = await goalActions.setGoalArchivedAction(
      IDLE,
      formData({ id: goal.id, archived: "false" })
    );
    expect(unarchived.status).toBe("success");
    const final = await readGoal("CP6 Goal Archivable");
    expect(final!.isArchived).toBe(false);
    expect(final!.savedCents).toBe(5000);
  });

  it("reports a clean not-found for an id the owner does not have", async () => {
    const state = await goalActions.setGoalArchivedAction(
      IDLE,
      formData({ id: "00000000-0000-4000-8000-000000000000", archived: "true" })
    );
    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

describe("createGoalContributionAction", () => {
  it("derives a positive amount for 'add' and updates savedCents exactly", async () => {
    const goal = await createGoal("CP6 Contribution Goal A");

    const state = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({
        id: crypto.randomUUID(),
        goalId: goal.id,
        action: "add",
        amount: "150.00",
        occurredOn: today,
        note: "first deposit",
      })
    );

    expect(state.status, state.formError ?? "").toBe("success");
    expect((await readGoal("CP6 Contribution Goal A"))!.savedCents).toBe(15000);
  });

  it("revalidates exactly the goal routes on success", async () => {
    const goal = await createGoal("CP6 Contribution Goal B");
    mocks.revalidated = [];

    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "" })
    );

    expect(mocks.revalidated).toEqual(GOAL_ROUTES);
  });

  it("derives a negative amount for 'withdraw', without deleting or editing the prior row", async () => {
    const goal = await createGoal("CP6 Contribution Goal C");
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "100.00", occurredOn: today, note: "" })
    );

    const withdrawal = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "withdraw", amount: "40.00", occurredOn: today, note: "" })
    );
    expect(withdrawal.status).toBe("success");

    expect((await readGoal("CP6 Contribution Goal C"))!.savedCents).toBe(6000);
    const history = await getGoalContributions(goal.id);
    expect(history).toHaveLength(2);
    expect(history.some((c) => c.amountCents === 10000)).toBe(true);
    expect(history.some((c) => c.amountCents === -4000)).toBe(true);
  });

  it("treats an exact retry under the same id as a successful no-op — exactly one row", async () => {
    const goal = await createGoal("CP6 Contribution Goal D");
    const id = crypto.randomUUID();
    const fields = { id, goalId: goal.id, action: "add", amount: "25.00", occurredOn: today, note: "" };

    const first = await contributionActions.createGoalContributionAction(IDLE, formData(fields));
    expect(first.status).toBe("success");
    const retry = await contributionActions.createGoalContributionAction(IDLE, formData(fields));
    expect(retry.status, retry.formError ?? "").toBe("success");

    expect(await getGoalContributions(goal.id)).toHaveLength(1);
  });

  it("reports a conflict when the same id is resubmitted with a different payload", async () => {
    const goal = await createGoal("CP6 Contribution Goal E");
    const id = crypto.randomUUID();
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id, goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "" })
    );

    const conflicting = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id, goalId: goal.id, action: "add", amount: "20.00", occurredOn: today, note: "" })
    );

    expect(conflicting.status).toBe("error");
    expect(await getGoalContributions(goal.id)).toHaveLength(1);
  });

  it("creates two real, distinct contributions from two different ids with identical contents", async () => {
    const goal = await createGoal("CP6 Contribution Goal F");
    const fields = { goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "same" };

    const first = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), ...fields })
    );
    const second = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), ...fields })
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(await getGoalContributions(goal.id)).toHaveLength(2);
    expect((await readGoal("CP6 Contribution Goal F"))!.savedCents).toBe(2000);
  });

  it("rejects a contribution dated after the owner's own calendar day", async () => {
    const goal = await createGoal("CP6 Contribution Goal G");
    const tomorrow = shiftCalendarDate(today, 1);

    const state = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "10.00", occurredOn: tomorrow, note: "" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.occurredOn).toBeDefined();
    expect(await getGoalContributions(goal.id)).toHaveLength(0);
  });

  it("rejects a contribution to an archived goal", async () => {
    const goal = await createGoal("CP6 Contribution Goal H");
    await goalActions.setGoalArchivedAction(IDLE, formData({ id: goal.id, archived: "true" }));

    const state = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("This goal is archived. Unarchive it before adding a contribution.");
    expect(await getGoalContributions(goal.id)).toHaveLength(0);
  });

  it("retains contribution history through an archive/unarchive cycle, and accepts new contributions after unarchiving", async () => {
    const goal = await createGoal("CP6 Contribution Goal I");
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "before archive" })
    );

    await goalActions.setGoalArchivedAction(IDLE, formData({ id: goal.id, archived: "true" }));
    expect(await getGoalContributions(goal.id)).toHaveLength(1);

    await goalActions.setGoalArchivedAction(IDLE, formData({ id: goal.id, archived: "false" }));

    const afterUnarchive = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "5.00", occurredOn: today, note: "after unarchive" })
    );
    expect(afterUnarchive.status).toBe("success");

    const history = await getGoalContributions(goal.id);
    expect(history).toHaveLength(2);
    expect((await readGoal("CP6 Contribution Goal I"))!.savedCents).toBe(1500);
  });

  it("reports a clean not-found for a goal id the owner does not have", async () => {
    const state = await contributionActions.createGoalContributionAction(
      IDLE,
      formData({
        id: crypto.randomUUID(),
        goalId: "00000000-0000-4000-8000-000000000000",
        action: "add",
        amount: "10.00",
        occurredOn: today,
        note: "",
      })
    );

    expect(state.status).toBe("error");
  });
});

describe("goal and contribution writes affect no other financial domain", () => {
  it("creates no account balance change and no transaction row", async () => {
    const { getAccounts } = await import("@/lib/data/accounts");
    const { getTransactions } = await import("@/lib/data/transactions");

    const accountsBefore = await getAccounts();
    const transactionsBefore = await getTransactions({});

    const goal = await createGoal("CP6 Isolation Goal");
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "add", amount: "10.00", occurredOn: today, note: "" })
    );
    await contributionActions.createGoalContributionAction(
      IDLE,
      formData({ id: crypto.randomUUID(), goalId: goal.id, action: "withdraw", amount: "3.00", occurredOn: today, note: "" })
    );

    expect(await getAccounts()).toEqual(accountsBefore);
    expect(await getTransactions({})).toEqual(transactionsBefore);
  });
});
