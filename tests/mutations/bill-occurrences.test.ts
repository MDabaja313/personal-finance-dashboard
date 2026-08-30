import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { BILL_ROUTES, IDLE, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Bill-occurrence status changes, end to end, plus the property this whole
 * checkpoint rests on: **bill tracking creates no ledger activity.**
 *
 * The financial-isolation block below is the important half. It reads every
 * figure a bill write could conceivably move — account balances, income,
 * spending, cash flow, net worth, the transaction count, and the current
 * month's net-worth snapshot — before and after marking paid, skipping,
 * unmarking and unskipping, and asserts each one is identical. Those reads go
 * through the real production DAL and the real `lib/finance/**` calculations,
 * so a regression that started writing a transaction from a bill action would
 * fail here rather than being noticed later by a person reconciling an
 * account.
 *
 * `getToday()` is not mocked, so the owner-timezone `paid_on` ceiling under
 * test is the real one.
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
const occurrenceActions = await import("@/lib/actions/bill-occurrences");
const transactionActions = await import("@/lib/actions/transactions");
const { getBills, getBillsForManagement } = await import("@/lib/data/bills");
const { getAccounts } = await import("@/lib/data/accounts");
const { getCategories } = await import("@/lib/data/categories");
const { getTransactions } = await import("@/lib/data/transactions");
const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const { getToday } = await import("@/lib/data/clock");
const { netWorth, totalAssets, totalLiabilities } = await import("@/lib/finance/accounts");
const { monthlyIncome, monthlySpending, monthlyCashFlow } = await import(
  "@/lib/finance/transactions"
);
const { monthKey } = await import("@/lib/finance/dates");

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

async function readBill(billId: string) {
  return (await getBillsForManagement()).find((bill) => bill.id === billId);
}

/**
 * A fresh bill with occurrences straddling today, so there is always both an
 * overdue occurrence to act on and a future one behind it.
 */
async function createBillWithHistory(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const state = await billActions.createBillAction(
    IDLE,
    formData({
      id,
      name,
      amount: "145.00",
      frequency: "monthly",
      anchorDate: shiftCalendarDate(today, -70),
      categoryId: "",
      accountId: "",
    })
  );
  expect(state.status, state.formError ?? "").toBe("success");
  return id;
}

/** The earliest scheduled occurrence of a bill — what "Mark paid" and "Skip" act on. */
async function nextScheduled(billId: string) {
  const bill = await readBill(billId);
  return bill!.occurrences
    .filter((o) => o.status === "scheduled")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
}

describe("markBillOccurrencePaidAction", () => {
  it("marks the next scheduled occurrence paid, with no linked transaction", async () => {
    const billId = await createBillWithHistory("CP7 Occ Paid A");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("paid");
    expect(stored.paidOn).toBe(today);
    expect(stored.transactionId).toBeUndefined();
    // The occurrence's own amount and due date are untouched.
    expect(stored.amountCents).toBe(occurrence.amountCents);
    expect(stored.dueDate).toBe(occurrence.dueDate);
  });

  it("optionally links an existing owned transaction, altering nothing about it", async () => {
    const billId = await createBillWithHistory("CP7 Occ Link");
    const occurrence = await nextScheduled(billId);

    const account = (await getAccounts()).find((a) => !a.isArchived)!;
    const category = (await getCategories()).find((c) => c.kind === "expense" && !c.isArchived)!;
    const transactionId = crypto.randomUUID();

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "CP7 Bill payment",
        kind: "expense",
        categoryId: category.id,
        amount: "200.00",
      })
    );

    const before = (await getTransactions({})).find((t) => t.id === transactionId)!;

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.transactionId).toBe(transactionId);

    // The linked transaction is byte-for-byte what it was: not
    // recategorised, not re-amounted, not re-dated, not replaced. Note the
    // amounts deliberately differ from the bill's — a bill is an expected
    // obligation and the transaction is what actually happened.
    const after = (await getTransactions({})).find((t) => t.id === transactionId)!;
    expect(after).toEqual(before);
    expect(after.amountCents).toBe(-20000);
    expect(stored.amountCents).toBe(14500);
  });

  it("is idempotent when the same mark is submitted twice", async () => {
    const billId = await createBillWithHistory("CP7 Occ Idempotent");
    const occurrence = await nextScheduled(billId);
    const fields = { id: occurrence.id, paidOn: today, transactionId: "" };

    const first = await occurrenceActions.markBillOccurrencePaidAction(IDLE, formData(fields));
    const second = await occurrenceActions.markBillOccurrencePaidAction(IDLE, formData(fields));

    expect(first.status, first.formError ?? "").toBe("success");
    expect(second.status, second.formError ?? "").toBe("success");

    const bill = await readBill(billId);
    expect(bill!.occurrences.filter((o) => o.id === occurrence.id)).toHaveLength(1);
    expect(bill!.occurrences.find((o) => o.id === occurrence.id)!.status).toBe("paid");
  });

  it("refuses a paid date in the owner's future", async () => {
    const billId = await createBillWithHistory("CP7 Occ Future");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: shiftCalendarDate(today, 1), transactionId: "" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.paidOn?.join(" ")).toMatch(/future/);

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });

  it("refuses a transaction that is not the caller's", async () => {
    const billId = await createBillWithHistory("CP7 Occ Foreign txn");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: crypto.randomUUID() })
    );

    expect(state.status).toBe("error");
    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });

  it("refuses to convert a skipped occurrence straight to paid", async () => {
    const billId = await createBillWithHistory("CP7 Occ Skip then paid");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/Unskip it before marking it paid/);
  });

  it("revalidates exactly the bill routes", async () => {
    const billId = await createBillWithHistory("CP7 Occ Revalidate");
    const occurrence = await nextScheduled(billId);
    mocks.revalidated = [];

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );

    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });
});

describe("skipBillOccurrenceAction", () => {
  it("skips a scheduled occurrence, preserving its amount and due date", async () => {
    const billId = await createBillWithHistory("CP7 Occ Skip");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.skipBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("skipped");
    expect(stored.paidOn).toBeUndefined();
    expect(stored.transactionId).toBeUndefined();
    expect(stored.amountCents).toBe(occurrence.amountCents);
    expect(stored.dueDate).toBe(occurrence.dueDate);
  });

  it("refuses to convert a paid occurrence straight to skipped", async () => {
    const billId = await createBillWithHistory("CP7 Occ Paid then skip");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );

    const state = await occurrenceActions.skipBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/Unmark it before skipping it/);
  });
});

describe("restoreBillOccurrenceAction", () => {
  it("unmarks a paid occurrence and clears its payment fields", async () => {
    const billId = await createBillWithHistory("CP7 Occ Unmark");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );

    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
    expect(stored.paidOn).toBeUndefined();
    expect(stored.transactionId).toBeUndefined();
  });

  it("unskips a skipped occurrence", async () => {
    const billId = await createBillWithHistory("CP7 Occ Unskip");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));
    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
    expect(stored.amountCents).toBe(occurrence.amountCents);
  });

  it("leaves a linked transaction completely untouched, and deletable again", async () => {
    const billId = await createBillWithHistory("CP7 Occ Unlink");
    const occurrence = await nextScheduled(billId);

    const account = (await getAccounts()).find((a) => !a.isArchived)!;
    const transactionId = crypto.randomUUID();
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "CP7 Unlink payment",
        kind: "expense",
        categoryId: "",
        amount: "31.00",
      })
    );

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId })
    );

    // While linked, the transaction cannot be deleted — the FK is not
    // weakened, and the message names the one thing that unblocks it.
    const refused = await transactionActions.deleteTransactionAction(
      IDLE,
      formData({ id: transactionId })
    );
    expect(refused.status).toBe("error");
    expect(refused.formError).toMatch(/Unmark that bill as paid first/);

    const before = (await getTransactions({})).find((t) => t.id === transactionId)!;

    await occurrenceActions.restoreBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));

    // The transaction is byte-for-byte what it was…
    const after = (await getTransactions({})).find((t) => t.id === transactionId)!;
    expect(after).toEqual(before);

    // …and now follows its ordinary deletion rules.
    const deleted = await transactionActions.deleteTransactionAction(
      IDLE,
      formData({ id: transactionId })
    );
    expect(deleted.status, deleted.formError ?? "").toBe("success");
    expect((await getTransactions({})).some((t) => t.id === transactionId)).toBe(false);
  });

  it("treats an already-scheduled occurrence as a successful no-op", async () => {
    const billId = await createBillWithHistory("CP7 Occ Restore noop");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );

    expect(state.status, state.formError ?? "").toBe("success");
    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });

  it("reports not-found for an occurrence that is not the caller's", async () => {
    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: crypto.randomUUID() })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

describe("the read side follows the occurrence state", () => {
  it("advances the projected next due date after marking paid, and after skipping", async () => {
    const billId = await createBillWithHistory("CP7 Read advance");

    const first = await nextScheduled(billId);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(first.dueDate);

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: first.id, paidOn: today, transactionId: "" })
    );

    const second = await nextScheduled(billId);
    expect(second.dueDate > first.dueDate).toBe(true);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(second.dueDate);

    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: second.id }));

    const third = await nextScheduled(billId);
    expect(third.dueDate > second.dueDate).toBe(true);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(third.dueDate);
  });

  it("sorts an overdue bill to the top of the dashboard projection", async () => {
    const billId = await createBillWithHistory("CP7 Read overdue");
    const bill = (await getBills()).find((b) => b.id === billId)!;
    expect(bill.dueDate < today).toBe(true);

    const upcoming = await getUpcoming();
    // Every bill ahead of this one in the queue is due no later than it is.
    const index = upcoming.findIndex((b) => b.id === billId);
    expect(index).toBeGreaterThanOrEqual(0);
    for (const earlier of upcoming.slice(0, index)) {
      expect(earlier.dueDate <= bill.dueDate).toBe(true);
    }
  });
});

/** The dashboard's own projection, read through the production DAL. */
async function getUpcoming() {
  const { getUpcomingBills } = await import("@/lib/data/bills");
  return getUpcomingBills(50);
}

describe("financial isolation — bill tracking writes no ledger activity", () => {
  /** Every figure a bill write could conceivably move, read through the real DAL. */
  async function financialState() {
    const accounts = await getAccounts();
    const transactions = await getTransactions({});
    const history = await getNetWorthHistory(24);

    return {
      balances: accounts.map((a) => `${a.id}:${a.balanceCents}`).sort(),
      assets: totalAssets(accounts),
      liabilities: totalLiabilities(accounts),
      netWorth: netWorth(accounts),
      income: monthlyIncome(transactions, monthKey(today)),
      spending: monthlySpending(transactions, monthKey(today)),
      cashFlow: monthlyCashFlow(transactions, monthKey(today)),
      transactionCount: transactions.length,
      transactionIds: transactions.map((t) => t.id).sort(),
      snapshots: history.map((s) => `${s.month}:${s.netWorthCents}:${s.assetsCents}:${s.liabilitiesCents}`),
    };
  }

  it("changes nothing financial across create, edit, archive, unarchive, paid, skip, unmark and unskip", async () => {
    const before = await financialState();

    // Create.
    const billId = crypto.randomUUID();
    await billActions.createBillAction(
      IDLE,
      formData({
        id: billId,
        name: "CP7 Isolation",
        amount: "500.00",
        frequency: "monthly",
        anchorDate: shiftCalendarDate(today, -35),
        categoryId: "",
        accountId: "",
      })
    );
    expect(await financialState()).toEqual(before);

    // Edit, including a terms change that rebuilds the whole future schedule.
    await billActions.updateBillAction(
      IDLE,
      formData({
        id: billId,
        name: "CP7 Isolation edited",
        amount: "900.00",
        frequency: "weekly",
        anchorDate: shiftCalendarDate(today, -35),
        categoryId: "",
        accountId: "",
      })
    );
    expect(await financialState()).toEqual(before);

    // Mark paid — the operation most likely to be mistaken for spending.
    const occurrence = await nextScheduled(billId);
    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );
    expect(await financialState()).toEqual(before);

    // Unmark.
    await occurrenceActions.restoreBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));
    expect(await financialState()).toEqual(before);

    // Skip and unskip.
    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));
    expect(await financialState()).toEqual(before);
    await occurrenceActions.restoreBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));
    expect(await financialState()).toEqual(before);

    // Archive and unarchive.
    await billActions.setBillArchivedAction(IDLE, formData({ id: billId, archived: "true" }));
    expect(await financialState()).toEqual(before);
    await billActions.setBillArchivedAction(IDLE, formData({ id: billId, archived: "false" }));
    expect(await financialState()).toEqual(before);
  }, 60_000);

  it("creates no transaction when an occurrence is marked paid manually", async () => {
    const billId = await createBillWithHistory("CP7 No txn");
    const occurrence = await nextScheduled(billId);
    const beforeIds = new Set((await getTransactions({})).map((t) => t.id));

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      formData({ id: occurrence.id, paidOn: today, transactionId: "" })
    );

    const afterIds = (await getTransactions({})).map((t) => t.id);
    expect(afterIds.filter((id) => !beforeIds.has(id))).toEqual([]);
  });
});
