import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { BILL_ROUTES, IDLE, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Bill writes, end to end — the same arrangement as every other file here:
 * real Server Actions, real validation, real mutation DAL, the real
 * `create_bill` / `replace_bill` / `set_bill_archived` RPCs and the real
 * `maintain_bill_schedule` scheduler bridge, against local Supabase with RLS
 * on, read back through the real production read DAL.
 *
 * `getToday()` is deliberately *not* mocked, here as everywhere: the rebuild
 * cutoff and the rolling horizon are computed inside the database from the
 * owner's `profiles.timezone`, and the assertions below compare against the
 * same real calendar day rather than a stubbed one.
 *
 * Every bill this file creates is created fresh through the real action
 * rather than borrowed from the seed, so nothing here depends on how the
 * seed's fixed 2026 due dates have aged. The seed's own bills are read
 * (never written) in the `getBills()` projection assertions.
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

const billActions = await import("@/lib/actions/bills");
const { getBills, getBillsForManagement, getUpcomingBills } = await import("@/lib/data/bills");
const { getCategories } = await import("@/lib/data/categories");
const { getAccounts } = await import("@/lib/data/accounts");
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

/** One managed bill, read back through the production DAL. */
async function readBill(billId: string) {
  return (await getBillsForManagement()).find((bill) => bill.id === billId);
}

/** Creates a bill through the real action and returns its id. */
async function createBill(fields: Record<string, string>): Promise<string> {
  const id = fields.id ?? crypto.randomUUID();
  const state = await billActions.createBillAction(IDLE, formData({ ...fields, id }));
  expect(state.status, state.formError ?? "").toBe("success");
  return id;
}

const BASE = {
  name: "CP7 Bill",
  amount: "145.00",
  frequency: "monthly",
  anchorDate: "2026-01-31",
  categoryId: "",
  accountId: "",
};

describe("createBillAction", () => {
  it("creates a bill and generates its schedule in one operation", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Create A" });

    const bill = await readBill(id);
    expect(bill).toBeDefined();
    expect(bill!.name).toBe("CP7 Create A");
    expect(bill!.amountCents).toBe(14500);
    expect(bill!.frequency).toBe("monthly");
    expect(bill!.anchorDate).toBe("2026-01-31");
    expect(bill!.isArchived).toBe(false);

    // The schedule exists, is entirely scheduled, and carries the bill's
    // amount copied at generation time.
    expect(bill!.occurrences.length).toBeGreaterThan(0);
    expect(bill!.occurrences.every((o) => o.status === "scheduled")).toBe(true);
    expect(bill!.occurrences.every((o) => o.amountCents === 14500)).toBe(true);
    expect(bill!.nextDueDate).toBeDefined();
  });

  it("preserves the Jan-31 monthly sequence with no date drift", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Jan31", anchorDate: "2026-01-31" });

    const dueDates = (await readBill(id))!.occurrences
      .map((o) => o.dueDate)
      .sort()
      .slice(0, 4);

    expect(dueDates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("returns a Feb-29 yearly bill to Feb 28 in a non-leap year", async () => {
    const id = await createBill({
      ...BASE,
      name: "CP7 Leap",
      frequency: "yearly",
      anchorDate: "2024-02-29",
    });

    const dueDates = (await readBill(id))!.occurrences.map((o) => o.dueDate).sort();

    expect(dueDates).toContain("2024-02-29");
    expect(dueDates).toContain("2025-02-28");
    // Every non-leap year clamps independently from the anchor, never from
    // the previous clamped value — so no year drifts to the 27th.
    expect(dueDates.every((d) => d.endsWith("-02-29") || d.endsWith("-02-28"))).toBe(true);
  });

  it("steps a weekly bill by 7 days and a biweekly bill by 14", async () => {
    const weekly = await createBill({
      ...BASE,
      name: "CP7 Weekly",
      frequency: "weekly",
      anchorDate: "2026-01-05",
    });
    const biweekly = await createBill({
      ...BASE,
      name: "CP7 Biweekly",
      frequency: "biweekly",
      anchorDate: "2026-01-05",
    });

    expect((await readBill(weekly))!.occurrences.map((o) => o.dueDate).sort().slice(0, 3)).toEqual([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
    ]);
    expect(
      (await readBill(biweekly))!.occurrences.map((o) => o.dueDate).sort().slice(0, 3)
    ).toEqual(["2026-01-05", "2026-01-19", "2026-02-02"]);
  });

  it("generates roughly a year ahead and no further", async () => {
    const id = await createBill({
      ...BASE,
      name: "CP7 Horizon",
      frequency: "monthly",
      anchorDate: today,
    });

    const dueDates = (await readBill(id))!.occurrences.map((o) => o.dueDate).sort();
    const horizon = shiftCalendarDate(today, 366);

    expect(dueDates[dueDates.length - 1] <= horizon).toBe(true);
    // And far enough ahead that a weekly bill would not need regenerating
    // for months: a monthly bill gets at least eleven future occurrences.
    expect(dueDates.filter((d) => d > today).length).toBeGreaterThanOrEqual(11);
  });

  it("still creates the anchor occurrence when the first due date is beyond the horizon", async () => {
    const farFuture = shiftCalendarDate(today, 900);
    const id = await createBill({
      ...BASE,
      name: "CP7 Far",
      frequency: "yearly",
      anchorDate: farFuture,
    });

    const bill = await readBill(id);
    expect(bill!.occurrences).toHaveLength(1);
    expect(bill!.occurrences[0].dueDate).toBe(farFuture);
    expect(bill!.nextDueDate).toBe(farFuture);
  });

  it("tracks a first due date that has already passed, without inventing earlier ones", async () => {
    const id = await createBill({
      ...BASE,
      name: "CP7 Late invoice",
      frequency: "monthly",
      anchorDate: shiftCalendarDate(today, -40),
    });

    const dueDates = (await readBill(id))!.occurrences.map((o) => o.dueDate).sort();
    expect(dueDates[0]).toBe(shiftCalendarDate(today, -40));
    expect(dueDates.filter((d) => d < shiftCalendarDate(today, -40))).toEqual([]);
  });

  it("accepts an optional active expense category and active account", async () => {
    const categories = await getCategories();
    const category = categories.find((c) => c.kind === "expense" && !c.isArchived)!;
    const account = (await getAccounts()).find((a) => !a.isArchived)!;

    const id = await createBill({
      ...BASE,
      name: "CP7 With refs",
      categoryId: category.id,
      accountId: account.id,
    });

    const bill = await readBill(id);
    expect(bill!.categoryId).toBe(category.id);
    expect(bill!.accountId).toBe(account.id);
  });

  it("leaves category and account absent when neither is chosen", async () => {
    const id = await createBill({ ...BASE, name: "CP7 No refs" });
    const bill = await readBill(id);
    expect(bill!.categoryId).toBeUndefined();
    expect(bill!.accountId).toBeUndefined();
  });

  it("accepts an income category — a bill's category kind is unconstrained", async () => {
    // No approved pre-CP7 requirement makes a bill's category an expense
    // category, so CP7 does not invent one. Asserted positively so a later
    // checkpoint cannot quietly introduce the narrower rule.
    const income = (await getCategories()).find((c) => c.kind === "income" && !c.isArchived)!;

    const id = await createBill({
      ...BASE,
      name: "CP7 Income cat",
      categoryId: income.id,
    });

    expect((await readBill(id))!.categoryId).toBe(income.id);
  });

  it("refuses an archived category", async () => {
    const categoryActions = await import("@/lib/actions/categories");
    const name = "CP7 Retired bill category";
    await categoryActions.createCategoryAction(IDLE, formData({ name, kind: "expense" }));
    const category = (await getCategories()).find((c) => c.name === name)!;
    await categoryActions.setCategoryArchivedAction(
      IDLE,
      formData({ id: category.id, archived: "true" })
    );

    const state = await billActions.createBillAction(
      IDLE,
      formData({ ...BASE, id: crypto.randomUUID(), name: "CP7 Bad cat", categoryId: category.id })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/archived or no longer usable/);
  });

  it("creates exactly one bill on an exact retry under the same key", async () => {
    const id = crypto.randomUUID();
    const fields = { ...BASE, id, name: "CP7 Retry" };

    const first = await billActions.createBillAction(IDLE, formData(fields));
    const second = await billActions.createBillAction(IDLE, formData(fields));

    expect(first.status, first.formError ?? "").toBe("success");
    // Deliberately indistinguishable from the first: the retry accomplished
    // what the person asked for.
    expect(second.status, second.formError ?? "").toBe("success");

    const matching = (await getBillsForManagement()).filter((b) => b.name === "CP7 Retry");
    expect(matching).toHaveLength(1);

    // And no second year of occurrences was generated.
    const occurrences = matching[0].occurrences;
    expect(new Set(occurrences.map((o) => o.dueDate)).size).toBe(occurrences.length);
  });

  it("reports a conflict when the same key is reused with a different payload", async () => {
    const id = crypto.randomUUID();
    await billActions.createBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Conflict", amount: "10.00" })
    );

    const second = await billActions.createBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Conflict", amount: "99.00" })
    );

    expect(second.status).toBe("error");
    expect(second.formError).toMatch(/different bill was already saved/);

    const stored = await readBill(id);
    expect(stored!.amountCents).toBe(1000);
  });

  it("revalidates exactly the bill routes on success", async () => {
    mocks.revalidated = [];
    await createBill({ ...BASE, name: "CP7 Revalidate create" });
    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });
});

describe("updateBillAction", () => {
  it("renames a bill without rebuilding its schedule", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Rename before" });
    const before = await readBill(id);
    const beforeIds = before!.occurrences.map((o) => o.id).sort();

    const state = await billActions.updateBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Rename after" })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await readBill(id);
    expect(after!.name).toBe("CP7 Rename after");
    // A metadata-only edit must not churn the schedule: same rows, same ids.
    expect(after!.occurrences.map((o) => o.id).sort()).toEqual(beforeIds);
  });

  it("rebuilds future scheduled occurrences with the new amount, and only those", async () => {
    const id = await createBill({
      ...BASE,
      name: "CP7 Amount edit",
      frequency: "monthly",
      anchorDate: shiftCalendarDate(today, -70),
    });

    // Mark the oldest occurrence paid and skip the next, so there is real
    // history for the rebuild to preserve.
    const before = await readBill(id);
    const past = before!.occurrences.filter((o) => o.dueDate < today).sort((a, b) =>
      a.dueDate.localeCompare(b.dueDate)
    );
    expect(past.length).toBeGreaterThanOrEqual(2);

    const occurrenceActions = await import("@/lib/actions/bill-occurrences");
    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: past[0].id, paidOn: today, transactionId: "" })
    );
    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: past[1].id }));

    const state = await billActions.updateBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Amount edit", amount: "999.00", anchorDate: shiftCalendarDate(today, -70) })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await readBill(id);
    expect(after!.amountCents).toBe(99900);

    const paid = after!.occurrences.find((o) => o.id === past[0].id);
    const skipped = after!.occurrences.find((o) => o.id === past[1].id);
    expect(paid!.amountCents).toBe(14500);
    expect(paid!.status).toBe("paid");
    expect(skipped!.amountCents).toBe(14500);
    expect(skipped!.status).toBe("skipped");

    // Overdue scheduled occurrences before today keep their old concrete
    // amount too — they are obligations that already fell due.
    for (const occurrence of after!.occurrences) {
      if (occurrence.dueDate < today && occurrence.status === "scheduled") {
        expect(occurrence.amountCents).toBe(14500);
      }
      if (occurrence.dueDate >= today) {
        expect(occurrence.amountCents).toBe(99900);
      }
    }
  });

  it("follows the new recurrence after a frequency and anchor change, leaving no stale future rows", async () => {
    const id = await createBill({
      ...BASE,
      name: "CP7 Terms edit",
      frequency: "monthly",
      anchorDate: shiftCalendarDate(today, -40),
    });

    const before = await readBill(id);
    const preservedIds = new Set(before!.occurrences.map((o) => o.id));

    const newAnchor = shiftCalendarDate(today, 2);
    const state = await billActions.updateBillAction(
      IDLE,
      formData({
        ...BASE,
        id,
        name: "CP7 Terms edit",
        frequency: "weekly",
        anchorDate: newAnchor,
      })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await readBill(id);
    const future = after!.occurrences.filter((o) => o.dueDate >= today);

    // Every future date is on the new weekly series from the new anchor.
    for (const occurrence of future) {
      const days =
        (Date.parse(`${occurrence.dueDate}T00:00:00Z`) - Date.parse(`${newAnchor}T00:00:00Z`)) /
        86_400_000;
      expect(days % 7).toBe(0);
      expect(days).toBeGreaterThanOrEqual(0);
    }

    // No duplicate due dates, and the projection is correct immediately.
    expect(new Set(after!.occurrences.map((o) => o.dueDate)).size).toBe(
      after!.occurrences.length
    );
    expect(after!.nextDueDate).toBe(
      after!.occurrences
        .filter((o) => o.status === "scheduled")
        .map((o) => o.dueDate)
        .sort()[0]
    );

    // And no past-dated occurrence was manufactured by the rebuild.
    for (const occurrence of after!.occurrences) {
      if (occurrence.dueDate < today) expect(preservedIds.has(occurrence.id)).toBe(true);
    }
  });

  it("rolls the whole edit back when the new schedule cannot be built", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Rollback", amount: "12.00" });
    const before = await readBill(id);

    // An archived category is the reference rule that actually exists — an
    // income category is accepted, so it cannot serve as the rollback trigger.
    const categoryActions = await import("@/lib/actions/categories");
    const name = "CP7 Rollback category";
    await categoryActions.createCategoryAction(IDLE, formData({ name, kind: "expense" }));
    const category = (await getCategories()).find((c) => c.name === name)!;
    await categoryActions.setCategoryArchivedAction(
      IDLE,
      formData({ id: category.id, archived: "true" })
    );

    const state = await billActions.updateBillAction(
      IDLE,
      formData({
        ...BASE,
        id,
        name: "CP7 Rollback edited",
        amount: "77.00",
        categoryId: category.id,
      })
    );

    expect(state.status).toBe("error");

    const after = await readBill(id);
    expect(after!.name).toBe("CP7 Rollback");
    expect(after!.amountCents).toBe(1200);
    expect(after!.occurrences.map((o) => o.id).sort()).toEqual(
      before!.occurrences.map((o) => o.id).sort()
    );
  });

  it("refuses to edit an archived bill", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Archived edit" });
    await billActions.setBillArchivedAction(IDLE, formData({ id, archived: "true" }));

    const state = await billActions.updateBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Archived edit changed" })
    );

    expect(state.status).toBe("error");
    expect((await readBill(id))!.name).toBe("CP7 Archived edit");
  });

  it("reports not-found for a bill that is not the caller's", async () => {
    const state = await billActions.updateBillAction(
      IDLE,
      formData({ ...BASE, id: crypto.randomUUID(), name: "CP7 Foreign" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });

  it("revalidates exactly the bill routes on success", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Revalidate edit" });
    mocks.revalidated = [];

    await billActions.updateBillAction(
      IDLE,
      formData({ ...BASE, id, name: "CP7 Revalidate edit 2" })
    );

    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });
});

describe("setBillArchivedAction", () => {
  it("keeps every occurrence and removes the bill from the active projection", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Archive" });
    const before = await readBill(id);
    const beforeIds = before!.occurrences.map((o) => o.id).sort();
    expect((await getBills()).some((b) => b.id === id)).toBe(true);

    const state = await billActions.setBillArchivedAction(IDLE, formData({ id, archived: "true" }));
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await readBill(id);
    expect(after!.isArchived).toBe(true);
    expect(after!.occurrences.map((o) => o.id).sort()).toEqual(beforeIds);

    // getBills() and the dashboard projection both drop it.
    expect((await getBills()).some((b) => b.id === id)).toBe(false);
    expect((await getUpcomingBills(50)).some((b) => b.id === id)).toBe(false);
  });

  it("restores history and a future horizon on unarchive", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Unarchive" });
    const beforeIds = (await readBill(id))!.occurrences.map((o) => o.id).sort();

    await billActions.setBillArchivedAction(IDLE, formData({ id, archived: "true" }));
    const state = await billActions.setBillArchivedAction(
      IDLE,
      formData({ id, archived: "false" })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await readBill(id);
    expect(after!.isArchived).toBe(false);
    // Every original occurrence is still there…
    for (const occurrenceId of beforeIds) {
      expect(after!.occurrences.some((o) => o.id === occurrenceId)).toBe(true);
    }
    // …and there is a usable horizon again. `nextDueDate` is deliberately
    // NOT asserted to be in the future: this bill is anchored before today,
    // so its earliest scheduled occurrence is legitimately overdue, and
    // that is exactly the row `/bills` must keep showing in the Overdue
    // group. What unarchiving restores is the *forward* schedule.
    expect(after!.nextDueDate).toBeDefined();
    expect(after!.occurrences.some((o) => o.status === "scheduled" && o.dueDate >= today)).toBe(
      true
    );
    expect((await getBills()).some((b) => b.id === id)).toBe(true);
  });

  it("revalidates exactly the bill routes", async () => {
    const id = await createBill({ ...BASE, name: "CP7 Revalidate archive" });
    mocks.revalidated = [];

    await billActions.setBillArchivedAction(IDLE, formData({ id, archived: "true" }));

    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });

  it("reports not-found for a bill that is not the caller's", async () => {
    const state = await billActions.setBillArchivedAction(
      IDLE,
      formData({ id: crypto.randomUUID(), archived: "true" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});
