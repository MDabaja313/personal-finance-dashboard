import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import {
  BILL_ROUTES,
  IDLE,
  LEDGER_BILL_ROUTES,
  formData,
  shiftCalendarDate,
} from "./support/mutation-harness";

/**
 * Bill-occurrence status changes, end to end, and the property that replaced
 * CP7's blanket "bill tracking creates no ledger activity":
 *
 *   A SCHEDULED occurrence is a projection and writes nothing.
 *   A SKIPPED occurrence writes nothing.
 *   Defining a bill writes nothing.
 *   Only scheduled -> paid may write a ledger row, and only when the bill
 *   names a usable account and no existing transaction was linked instead.
 *   Only paid -> scheduled may remove one, and only the row it generated.
 *
 * The financial-isolation blocks are the important half in both directions.
 * The first reads every figure a bill write could conceivably move — account
 * balances, income, spending, cash flow, net worth, the transaction count, and
 * the current month's net-worth snapshot — before and after every operation
 * that must not move them, and asserts each is identical. The second does the
 * same around a *generated* payment and asserts that each figure moved by
 * exactly the occurrence's amount and then came back.
 *
 * Those reads go through the real production DAL and the real
 * `lib/finance/**` calculations, so both a regression that started writing a
 * transaction from a skip and one that stopped writing one from a settlement
 * fail here rather than being noticed later by a person reconciling an account.
 *
 * `getToday()` is not mocked, so the owner-timezone `paid_on` ceiling under
 * test is the real one — and it is also the ceiling the generated expense's
 * own date has to clear.
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
const { getBudgets } = await import("@/lib/data/budgets");
const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const { getToday } = await import("@/lib/data/clock");
const { netWorth, totalAssets, totalLiabilities } = await import("@/lib/finance/accounts");
const { monthlyIncome, monthlySpending, monthlyCashFlow } = await import(
  "@/lib/finance/transactions"
);
const { budgetStatus } = await import("@/lib/finance/budgets");
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
 *
 * `accountId` defaults to none, which is the *status-only* settlement path —
 * the behaviour CP7 established and Phase 8 preserves unchanged for a bill
 * that names no account. Tests about generated payments pass one explicitly.
 */
async function createBillWithHistory(
  name: string,
  options: { accountId?: string; categoryId?: string; amount?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID();
  const state = await billActions.createBillAction(
    IDLE,
    formData({
      id,
      name,
      amount: options.amount ?? "145.00",
      frequency: "monthly",
      anchorDate: shiftCalendarDate(today, -70),
      categoryId: options.categoryId ?? "",
      accountId: options.accountId ?? "",
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

/** The mark-paid submission a form would post — the generated key is always present. */
function markPaidFields(
  occurrenceId: string,
  extra: { paidOn?: string; transactionId?: string; generatedTransactionId?: string } = {}
) {
  return formData({
    id: occurrenceId,
    paidOn: extra.paidOn ?? today,
    transactionId: extra.transactionId ?? "",
    generatedTransactionId: extra.generatedTransactionId ?? crypto.randomUUID(),
  });
}

async function activeAccount() {
  return (await getAccounts()).find((a) => !a.isArchived)!;
}

async function activeExpenseCategory() {
  return (await getCategories()).find((c) => c.kind === "expense" && !c.isArchived)!;
}

describe("markBillOccurrencePaidAction — status only (the bill names no account)", () => {
  it("marks the next scheduled occurrence paid, with no linked transaction", async () => {
    const billId = await createBillWithHistory("P8 Occ Paid A");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id)
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("paid");
    expect(stored.paidOn).toBe(today);
    expect(stored.transactionId).toBeUndefined();
    expect(stored.transactionOrigin).toBeUndefined();
    // The occurrence's own amount and due date are untouched.
    expect(stored.amountCents).toBe(occurrence.amountCents);
    expect(stored.dueDate).toBe(occurrence.dueDate);
  });

  it("creates no transaction at all", async () => {
    const billId = await createBillWithHistory("P8 No txn");
    const occurrence = await nextScheduled(billId);
    const beforeIds = new Set((await getTransactions({})).map((t) => t.id));

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));

    const afterIds = (await getTransactions({})).map((t) => t.id);
    expect(afterIds.filter((id) => !beforeIds.has(id))).toEqual([]);
  });

  it("revalidates only the two bill routes", async () => {
    const billId = await createBillWithHistory("P8 Occ Revalidate");
    const occurrence = await nextScheduled(billId);
    mocks.revalidated = [];

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));

    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });
});

describe("markBillOccurrencePaidAction — linking an existing transaction", () => {
  it("links it, alters nothing about it, and generates nothing", async () => {
    // The bill *does* name an account here, so the only reason no row is
    // generated is that one was linked instead. Without that, this test would
    // pass for the wrong reason.
    const account = await activeAccount();
    const category = await activeExpenseCategory();
    const billId = await createBillWithHistory("P8 Occ Link", {
      accountId: account.id,
      categoryId: category.id,
    });
    const occurrence = await nextScheduled(billId);

    const transactionId = crypto.randomUUID();
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "P8 Bill payment",
        kind: "expense",
        categoryId: category.id,
        amount: "200.00",
      })
    );

    const before = (await getTransactions({})).find((t) => t.id === transactionId)!;
    const countBefore = (await getTransactions({})).length;
    const generatedKey = crypto.randomUUID();

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { transactionId, generatedTransactionId: generatedKey })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.transactionId).toBe(transactionId);
    expect(stored.transactionOrigin).toBe("linked");

    // The linked transaction is byte-for-byte what it was: not recategorised,
    // not re-amounted, not re-dated, not replaced. Note the amounts
    // deliberately differ from the bill's — a bill is an expected obligation
    // and the transaction is what actually happened.
    const after = (await getTransactions({})).find((t) => t.id === transactionId)!;
    expect(after).toEqual(before);
    expect(after.amountCents).toBe(-20000);
    expect(stored.amountCents).toBe(14500);

    // And nothing new exists — the unused generated key wrote no row.
    const all = await getTransactions({});
    expect(all.length).toBe(countBefore);
    expect(all.some((t) => t.id === generatedKey)).toBe(false);
  });

  it("revalidates only the two bill routes — a link moves no figure", async () => {
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Link revalidate", { accountId: account.id });
    const occurrence = await nextScheduled(billId);

    const transactionId = crypto.randomUUID();
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "P8 Link revalidate payment",
        kind: "expense",
        categoryId: "",
        amount: "12.00",
      })
    );

    mocks.revalidated = [];
    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { transactionId })
    );

    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });

  it("refuses a transaction that is not the caller's", async () => {
    const billId = await createBillWithHistory("P8 Occ Foreign txn");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { transactionId: crypto.randomUUID() })
    );

    expect(state.status).toBe("error");
    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });
});

describe("markBillOccurrencePaidAction — generating the payment", () => {
  it("creates exactly one expense, from the occurrence's own amount", async () => {
    const account = await activeAccount();
    const category = await activeExpenseCategory();
    // The bill is repriced *after* its occurrences were generated, so the
    // parent's current amount and the occurrence's differ. The generated row
    // must take the occurrence's.
    const billId = await createBillWithHistory("P8 Gen amount", {
      accountId: account.id,
      categoryId: category.id,
      amount: "60.00",
    });
    const occurrence = await nextScheduled(billId);
    expect(occurrence.amountCents).toBe(6000);

    await billActions.updateBillAction(
      IDLE,
      formData({
        id: billId,
        name: "P8 Gen amount",
        amount: "999.00",
        frequency: "monthly",
        // The anchor is unchanged, so only the amount moved — which rebuilds
        // the *future* schedule and leaves this overdue occurrence alone.
        anchorDate: shiftCalendarDate(today, -70),
        categoryId: category.id,
        accountId: account.id,
      })
    );

    const beforeIds = new Set((await getTransactions({})).map((t) => t.id));
    const generatedKey = crypto.randomUUID();

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: generatedKey })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const after = await getTransactions({});
    const created = after.filter((t) => !beforeIds.has(t.id));
    expect(created).toHaveLength(1);

    const payment = created[0];
    expect(payment.id).toBe(generatedKey);
    expect(payment.kind).toBe("expense");
    // Negative in storage, and the occurrence's amount rather than the bill's
    // current 999.00.
    expect(payment.amountCents).toBe(-6000);
    expect(payment.accountId).toBe(account.id);
    expect(payment.categoryId).toBe(category.id);
    expect(payment.date).toBe(today);
    expect(payment.merchant).toBe("P8 Gen amount");
    expect(payment.movementId).toBeUndefined();

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.transactionId).toBe(generatedKey);
    expect(stored.transactionOrigin).toBe("generated");
  });

  it("dates the expense on the paid date, not the due date", async () => {
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Gen date", { accountId: account.id });
    const occurrence = await nextScheduled(billId);
    const paidOn = shiftCalendarDate(today, -3);
    const generatedKey = crypto.randomUUID();

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { paidOn, generatedTransactionId: generatedKey })
    );

    const payment = (await getTransactions({})).find((t) => t.id === generatedKey)!;
    expect(payment.date).toBe(paidOn);
    expect(payment.date).not.toBe(occurrence.dueDate);
  });

  it("creates the expense uncategorized when the bill's category cannot label one", async () => {
    // A bill's category kind is deliberately unconstrained (CP7); an expense
    // transaction's is not. Dropping the label beats refusing the settlement.
    const account = await activeAccount();
    const incomeCategory = (await getCategories()).find(
      (c) => c.kind === "income" && !c.isArchived
    )!;
    const billId = await createBillWithHistory("P8 Gen odd category", {
      accountId: account.id,
      categoryId: incomeCategory.id,
    });
    const occurrence = await nextScheduled(billId);
    const generatedKey = crypto.randomUUID();

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: generatedKey })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const payment = (await getTransactions({})).find((t) => t.id === generatedKey)!;
    expect(payment.categoryId).toBeUndefined();
    expect(payment.kind).toBe("expense");
  });

  it("revalidates every route a ledger row touches", async () => {
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Gen revalidate", { accountId: account.id });
    const occurrence = await nextScheduled(billId);
    mocks.revalidated = [];

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));

    expect(mocks.revalidated).toEqual(LEDGER_BILL_ROUTES);
  });

  it("does not duplicate on a repeated mark-paid, even with a fresh key", async () => {
    // The retry-after-lost-response case, which is the one that matters: the
    // row was written, the person never saw the confirmation, and pressing the
    // button again is the only sensible thing they can do.
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Gen idempotent", { accountId: account.id });
    const occurrence = await nextScheduled(billId);
    const beforeIds = new Set((await getTransactions({})).map((t) => t.id));

    const first = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id)
    );
    // A *different* generated key, which is what a remounted form would post.
    const second = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id)
    );
    // And a third with the identical key of a form that never unmounted.
    const key = crypto.randomUUID();
    const third = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: key })
    );
    const fourth = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: key })
    );

    for (const state of [first, second, third, fourth]) {
      expect(state.status, state.formError ?? "").toBe("success");
    }

    const created = (await getTransactions({})).filter((t) => !beforeIds.has(t.id));
    expect(created).toHaveLength(1);

    const bill = await readBill(billId);
    expect(bill!.occurrences.filter((o) => o.id === occurrence.id)).toHaveLength(1);
    expect(bill!.occurrences.find((o) => o.id === occurrence.id)!.status).toBe("paid");
  });
});

describe("markBillOccurrencePaidAction — refusals", () => {
  it("refuses a paid date in the owner's future", async () => {
    const billId = await createBillWithHistory("P8 Occ Future");
    const occurrence = await nextScheduled(billId);

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { paidOn: shiftCalendarDate(today, 1) })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.paidOn?.join(" ")).toMatch(/future/);

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });

  it("refuses a future paid date on a generating bill too, writing nothing", async () => {
    // The ceiling `assert_transaction_refs()` puts on the generated expense's
    // date is the same one the occurrence's `paid_on` clears, so a refusal must
    // leave neither behind.
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Gen future", { accountId: account.id });
    const occurrence = await nextScheduled(billId);
    const generatedKey = crypto.randomUUID();

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, {
        paidOn: shiftCalendarDate(today, 1),
        generatedTransactionId: generatedKey,
      })
    );

    expect(state.status).toBe("error");
    expect((await getTransactions({})).some((t) => t.id === generatedKey)).toBe(false);
    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
  });

  it("refuses to convert a skipped occurrence straight to paid", async () => {
    const billId = await createBillWithHistory("P8 Occ Skip then paid");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));

    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id)
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/Unskip it before marking it paid/);
  });

  it("refuses an occurrence that is not the caller's", async () => {
    const state = await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(crypto.randomUUID())
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

describe("skipBillOccurrenceAction", () => {
  it("skips a scheduled occurrence, preserving its amount and due date", async () => {
    const billId = await createBillWithHistory("P8 Occ Skip");
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
    expect(stored.transactionOrigin).toBeUndefined();
    expect(stored.amountCents).toBe(occurrence.amountCents);
    expect(stored.dueDate).toBe(occurrence.dueDate);
  });

  it("creates no transaction, even for a bill that would generate one", async () => {
    // Skipping is the operation most easily confused with a payment, and the
    // bill here is fully configured to generate — so the only reason nothing
    // is written is that skipping never writes.
    const account = await activeAccount();
    const category = await activeExpenseCategory();
    const billId = await createBillWithHistory("P8 Skip no ledger", {
      accountId: account.id,
      categoryId: category.id,
    });
    const occurrence = await nextScheduled(billId);
    const beforeIds = new Set((await getTransactions({})).map((t) => t.id));

    mocks.revalidated = [];
    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));

    const created = (await getTransactions({})).filter((t) => !beforeIds.has(t.id));
    expect(created).toEqual([]);
    expect(mocks.revalidated).toEqual(BILL_ROUTES);
  });

  it("refuses to convert a paid occurrence straight to skipped", async () => {
    const billId = await createBillWithHistory("P8 Occ Paid then skip");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));

    const state = await occurrenceActions.skipBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/Unmark it before skipping it/);
  });
});

describe("restoreBillOccurrenceAction", () => {
  it("unmarks a status-only payment and clears its payment fields", async () => {
    const billId = await createBillWithHistory("P8 Occ Unmark");
    const occurrence = await nextScheduled(billId);

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));

    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
    expect(stored.paidOn).toBeUndefined();
    expect(stored.transactionId).toBeUndefined();
    expect(stored.transactionOrigin).toBeUndefined();
  });

  it("unskips a skipped occurrence", async () => {
    const billId = await createBillWithHistory("P8 Occ Unskip");
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

  it("removes the generated payment, and only that", async () => {
    const account = await activeAccount();
    const billId = await createBillWithHistory("P8 Unmark generated", { accountId: account.id });
    const occurrence = await nextScheduled(billId);
    const generatedKey = crypto.randomUUID();

    const beforeIds = (await getTransactions({})).map((t) => t.id).sort();

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: generatedKey })
    );
    expect((await getTransactions({})).some((t) => t.id === generatedKey)).toBe(true);

    mocks.revalidated = [];
    const state = await occurrenceActions.restoreBillOccurrenceAction(
      IDLE,
      formData({ id: occurrence.id })
    );
    expect(state.status, state.formError ?? "").toBe("success");

    // The generated row is gone, and every other transaction survived.
    expect((await getTransactions({})).map((t) => t.id).sort()).toEqual(beforeIds);
    expect(mocks.revalidated).toEqual(LEDGER_BILL_ROUTES);

    const stored = (await readBill(billId))!.occurrences.find((o) => o.id === occurrence.id)!;
    expect(stored.status).toBe("scheduled");
    expect(stored.transactionId).toBeUndefined();
    expect(stored.transactionOrigin).toBeUndefined();
  });

  it("leaves a manually linked transaction completely untouched, and deletable again", async () => {
    // The assertion the whole provenance mechanism exists to guarantee.
    const billId = await createBillWithHistory("P8 Occ Unlink");
    const occurrence = await nextScheduled(billId);

    const account = await activeAccount();
    const transactionId = crypto.randomUUID();
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: transactionId,
        accountId: account.id,
        date: today,
        merchant: "P8 Unlink payment",
        kind: "expense",
        categoryId: "",
        amount: "31.00",
      })
    );

    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { transactionId })
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

    mocks.revalidated = [];
    await occurrenceActions.restoreBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));

    // The transaction is byte-for-byte what it was, and still exists…
    const after = (await getTransactions({})).find((t) => t.id === transactionId)!;
    expect(after).toEqual(before);
    // …so the unmark moved no figure and revalidated only the bill routes.
    expect(mocks.revalidated).toEqual(BILL_ROUTES);

    // …and now follows its ordinary deletion rules.
    const deleted = await transactionActions.deleteTransactionAction(
      IDLE,
      formData({ id: transactionId })
    );
    expect(deleted.status, deleted.formError ?? "").toBe("success");
    expect((await getTransactions({})).some((t) => t.id === transactionId)).toBe(false);
  });

  it("treats an already-scheduled occurrence as a successful no-op", async () => {
    const billId = await createBillWithHistory("P8 Occ Restore noop");
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
    const billId = await createBillWithHistory("P8 Read advance");

    const first = await nextScheduled(billId);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(first.dueDate);

    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(first.id));

    const second = await nextScheduled(billId);
    expect(second.dueDate > first.dueDate).toBe(true);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(second.dueDate);

    await occurrenceActions.skipBillOccurrenceAction(IDLE, formData({ id: second.id }));

    const third = await nextScheduled(billId);
    expect(third.dueDate > second.dueDate).toBe(true);
    expect((await getBills()).find((b) => b.id === billId)!.dueDate).toBe(third.dueDate);
  });

  it("sorts an overdue bill to the top of the dashboard projection", async () => {
    const billId = await createBillWithHistory("P8 Read overdue");
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
    snapshots: history.map(
      (s) => `${s.month}:${s.netWorthCents}:${s.assetsCents}:${s.liabilitiesCents}`
    ),
  };
}

describe("financial isolation — everything that must still write no ledger activity", () => {
  it("changes nothing financial across create, edit, archive, unarchive, paid, skip, unmark and unskip", async () => {
    // The bill names no account, so every operation below is status-only —
    // exactly the CP7 contract, preserved unchanged for a bill this
    // application has no ledger information for.
    const before = await financialState();

    // Create.
    const billId = crypto.randomUUID();
    await billActions.createBillAction(
      IDLE,
      formData({
        id: billId,
        name: "P8 Isolation",
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
        name: "P8 Isolation edited",
        amount: "900.00",
        frequency: "weekly",
        anchorDate: shiftCalendarDate(today, -35),
        categoryId: "",
        accountId: "",
      })
    );
    expect(await financialState()).toEqual(before);

    // Mark paid — the operation most likely to be mistaken for spending, and
    // still inert for a bill with no account.
    const occurrence = await nextScheduled(billId);
    await occurrenceActions.markBillOccurrencePaidAction(IDLE, markPaidFields(occurrence.id));
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

  it("leaves every figure alone while a bill that *would* generate is only defined and edited", async () => {
    // The same isolation claim for a fully-configured bill: creating it,
    // repricing it and archiving it are descriptions of an obligation, not
    // economic events. Only settling one is.
    const account = await activeAccount();
    const category = await activeExpenseCategory();
    const before = await financialState();

    const billId = crypto.randomUUID();
    await billActions.createBillAction(
      IDLE,
      formData({
        id: billId,
        name: "P8 Defined only",
        amount: "77.00",
        frequency: "monthly",
        anchorDate: shiftCalendarDate(today, -35),
        categoryId: category.id,
        accountId: account.id,
      })
    );
    expect(await financialState()).toEqual(before);

    await billActions.updateBillAction(
      IDLE,
      formData({
        id: billId,
        name: "P8 Defined only edited",
        amount: "88.00",
        frequency: "monthly",
        anchorDate: shiftCalendarDate(today, -35),
        categoryId: category.id,
        accountId: account.id,
      })
    );
    expect(await financialState()).toEqual(before);

    await billActions.setBillArchivedAction(IDLE, formData({ id: billId, archived: "true" }));
    expect(await financialState()).toEqual(before);
    await billActions.setBillArchivedAction(IDLE, formData({ id: billId, archived: "false" }));
    expect(await financialState()).toEqual(before);
  }, 60_000);
});

describe("ledger effect — a generated payment moves exactly what an expense moves, and unwinds", () => {
  it("moves the balance, the month's spending, and the category's budget, then returns", async () => {
    const account = await activeAccount();
    const category = await activeExpenseCategory();

    // A budget for the same category, so utilisation is a figure this test can
    // watch rather than a claim it has to trust.
    const budgetKey = crypto.randomUUID();
    const { createBudgetAction, deleteBudgetAction } = await import("@/lib/actions/budgets");
    const period = monthKey(today);
    const existingBudget = (await getBudgets(period)).find((b) => b.categoryId === category.id);
    if (existingBudget === undefined) {
      await createBudgetAction(
        IDLE,
        formData({ id: budgetKey, categoryId: category.id, limit: "5000.00" })
      );
    }

    const budgetFor = async () => {
      const budgets = await getBudgets(period);
      const budget = budgets.find((b) => b.categoryId === category.id)!;
      return budgetStatus(budget, await getTransactions({ month: period })).spentCents;
    };

    const before = await financialState();
    const spentBefore = await budgetFor();

    const billId = await createBillWithHistory("P8 Ledger effect", {
      accountId: account.id,
      categoryId: category.id,
      amount: "42.50",
    });
    // Defining the bill moved nothing.
    expect(await financialState()).toEqual(before);

    const occurrence = await nextScheduled(billId);
    const generatedKey = crypto.randomUUID();
    await occurrenceActions.markBillOccurrencePaidAction(
      IDLE,
      markPaidFields(occurrence.id, { generatedTransactionId: generatedKey })
    );

    const during = await financialState();
    // The account balance fell by exactly the occurrence's amount…
    expect(during.netWorth).toBe(before.netWorth - 4250);
    // …the month's spending rose by it…
    expect(during.spending).toBe(before.spending + 4250);
    expect(during.cashFlow).toBe(before.cashFlow - 4250);
    // …income did not move, because an expense is not income…
    expect(during.income).toBe(before.income);
    // …and exactly one transaction appeared.
    expect(during.transactionCount).toBe(before.transactionCount + 1);
    // …and the category's budget counts it.
    expect(await budgetFor()).toBe(spentBefore + 4250);

    // The snapshot for the current month was refreshed rather than left stale.
    const { snapshotHealth } = await import("@/lib/finance/trends");
    const health = snapshotHealth(await getAccounts(), await getNetWorthHistory(24), period);
    expect(health.status).toBe("healthy");

    // Unmarking returns every one of them.
    await occurrenceActions.restoreBillOccurrenceAction(IDLE, formData({ id: occurrence.id }));
    expect(await financialState()).toEqual(before);
    expect(await budgetFor()).toBe(spentBefore);

    if (existingBudget === undefined) {
      await deleteBudgetAction(IDLE, formData({ id: budgetKey }));
    }
  }, 60_000);
});
