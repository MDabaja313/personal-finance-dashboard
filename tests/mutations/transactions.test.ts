import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { IDLE, TRANSACTION_ROUTES, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Transaction writes, end to end: real Server Actions → real validation → real
 * mutation DAL → real local Supabase (RLS on, ordinary `authenticated` JWT) →
 * read back through the real production read DAL.
 *
 * ## What this proves that nothing else can
 *
 * `npm test` proves the schemas and the action control flow in isolation.
 * `npm run db:test` proves the grants, the policies, the constraints and
 * `assert_transaction_refs()` in isolation. Neither proves they are *wired
 * together* — that the action posts the columns the grant allows, that the
 * DAL's preflight and the database's trigger agree about what is refused, that
 * an idempotent retry really produces one row and not two, or that a write is
 * visible to the read path and moves the balances and KPIs afterwards. That is
 * this file's whole job, and it is why the only things mocked are the Supabase
 * seam plus the two Next.js request-scoped functions.
 *
 * Note in particular that `getToday()` is **not** mocked: the action resolves
 * the owner's calendar day through the real clock, which reads
 * `profiles.timezone` through the same seam. So the ceiling these tests
 * exercise is the same one production uses, and "tomorrow" below is genuinely
 * the owner's tomorrow rather than the test machine's.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: "" as string,
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

// The one seam lib/data/** uses to reach the database. Everything downstream of
// it — mappers, query builders, preflights, error mapping, the clock — is real.
vi.mock("@/lib/data/supabase", () => ({
  getDataClient: async () => mocks.client,
  getOwnerId: async () => mocks.ownerId,
}));

// Request-scoped Next.js functions, recorded rather than no-oped.
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

const actions = await import("@/lib/actions/transactions");
const { getAccounts } = await import("@/lib/data/accounts");
const { getCategories } = await import("@/lib/data/categories");
const { getToday } = await import("@/lib/data/clock");
const { getTransactions } = await import("@/lib/data/transactions");
const { monthlyIncome, monthlySpending, monthlyCashFlow, spendingByCategory } = await import(
  "@/lib/finance/transactions"
);
const { monthKey } = await import("@/lib/finance/dates");

let context: Awaited<ReturnType<typeof createMutationContext>>;
/** The owner's own calendar day, resolved once through the real clock. */
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

// ============================================================
// Fixtures, read back through the production DAL
// ============================================================

async function accountByName(name: string) {
  const account = (await getAccounts()).find((a) => a.name === name);
  expect(account, `the seed should provide the '${name}' account`).toBeDefined();
  return account!;
}

async function categoryByName(name: string) {
  const category = (await getCategories()).find((c) => c.name === name);
  expect(category, `the seed should provide the '${name}' category`).toBeDefined();
  return category!;
}

async function transactionById(id: string) {
  return (await getTransactions()).find((t) => t.id === id);
}

/** A complete create submission with a fresh idempotency key. */
function createForm(fields: Record<string, string>): FormData {
  return formData({
    id: randomUUID(),
    date: shiftCalendarDate(today, -3),
    categoryId: "",
    ...fields,
  });
}

// ============================================================
// Create
// ============================================================

describe("createTransactionAction", () => {
  it("creates an expense and stores it negative, visible through the production read DAL", async () => {
    const account = await accountByName("Everyday Checking");
    const category = await categoryByName("Groceries");
    const id = randomUUID();

    const state = await actions.createTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: shiftCalendarDate(today, -2),
        merchant: "CP3 Expense",
        kind: "expense",
        categoryId: category.id,
        amount: "42.50",
      })
    );

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();

    const stored = await transactionById(id);
    expect(stored).toBeDefined();
    // The form posted a magnitude; the sign comes from the kind.
    expect(stored!.amountCents).toBe(-4250);
    expect(stored!.kind).toBe("expense");
    expect(stored!.merchant).toBe("CP3 Expense");
    expect(stored!.categoryId).toBe(category.id);
    expect(stored!.accountId).toBe(account.id);
    // Ordinary rows are never part of a movement.
    expect(stored!.movementId).toBeUndefined();
  });

  it("creates income and a refund, both stored positive", async () => {
    const account = await accountByName("Everyday Checking");
    const salary = await categoryByName("Salary");
    const groceries = await categoryByName("Groceries");

    const incomeId = randomUUID();
    const incomeState = await actions.createTransactionAction(
      IDLE,
      createForm({
        id: incomeId,
        accountId: account.id,
        merchant: "CP3 Income",
        kind: "income",
        categoryId: salary.id,
        amount: "1,500.00",
      })
    );
    expect(incomeState.status).toBe("success");
    expect((await transactionById(incomeId))!.amountCents).toBe(150_000);

    // A refund takes an EXPENSE category: it reduces that category's spend
    // rather than adding income.
    const refundId = randomUUID();
    const refundState = await actions.createTransactionAction(
      IDLE,
      createForm({
        id: refundId,
        accountId: account.id,
        merchant: "CP3 Refund",
        kind: "refund",
        categoryId: groceries.id,
        amount: "12.99",
      })
    );
    expect(refundState.status).toBe("success");
    expect((await transactionById(refundId))!.amountCents).toBe(1299);
  });

  it("accepts a zero-amount, uncategorized ordinary transaction", async () => {
    // Legal in this schema and deliberately so: a fully discounted order or a
    // waived fee is a real thing to record, and the database's sign check is
    // non-strict for exactly that reason.
    const account = await accountByName("Everyday Checking");
    const id = randomUUID();

    const state = await actions.createTransactionAction(
      IDLE,
      createForm({
        id,
        accountId: account.id,
        merchant: "CP3 Waived Fee",
        kind: "expense",
        categoryId: "",
        amount: "0",
      })
    );

    expect(state.status).toBe("success");
    const stored = await transactionById(id);
    expect(stored!.amountCents).toBe(0);
    expect(Object.is(stored!.amountCents, -0)).toBe(false);
    expect(stored!.categoryId).toBeUndefined();
  });

  it("accepts today and refuses the owner's tomorrow", async () => {
    const account = await accountByName("Everyday Checking");

    const todayId = randomUUID();
    const accepted = await actions.createTransactionAction(
      IDLE,
      createForm({
        id: todayId,
        accountId: account.id,
        date: today,
        merchant: "CP3 Today",
        kind: "expense",
        amount: "1.00",
      })
    );
    expect(accepted.status).toBe("success");
    expect(await transactionById(todayId)).toBeDefined();

    // Cleared so the assertion below is about the *refused* call, not about
    // the successful one that preceded it in this test.
    mocks.revalidated = [];

    const tomorrowId = randomUUID();
    const refused = await actions.createTransactionAction(
      IDLE,
      createForm({
        id: tomorrowId,
        accountId: account.id,
        date: shiftCalendarDate(today, 1),
        merchant: "CP3 Tomorrow",
        kind: "expense",
        amount: "1.00",
      })
    );

    expect(refused.status).toBe("error");
    expect(refused.fieldErrors.date?.length).toBeGreaterThan(0);
    expect(await transactionById(tomorrowId)).toBeUndefined();
    // Refused before any query ran, so nothing may be invalidated.
    expect(mocks.revalidated).toEqual([]);
  });

  it("refuses an archived account", async () => {
    const archived = (await getAccounts()).find((a) => a.isArchived);
    expect(archived, "the seed should provide an archived account").toBeDefined();

    const id = randomUUID();
    const state = await actions.createTransactionAction(
      IDLE,
      createForm({
        id,
        accountId: archived!.id,
        merchant: "CP3 Into Archive",
        kind: "expense",
        amount: "5.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/account or category/i);
    expect(await transactionById(id)).toBeUndefined();
    expect(mocks.revalidated).toEqual([]);
  });

  it("refuses a category whose kind does not match the transaction's", async () => {
    const account = await accountByName("Everyday Checking");
    const salary = await categoryByName("Salary");

    const id = randomUUID();
    const state = await actions.createTransactionAction(
      IDLE,
      createForm({
        id,
        accountId: account.id,
        merchant: "CP3 Mismatch",
        kind: "expense",
        categoryId: salary.id,
        amount: "5.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/account or category/i);
    expect(await transactionById(id)).toBeUndefined();
  });

  it("revalidates exactly the five transaction routes on success", async () => {
    const account = await accountByName("Everyday Checking");

    await actions.createTransactionAction(
      IDLE,
      createForm({
        id: randomUUID(),
        accountId: account.id,
        merchant: "CP3 Revalidation",
        kind: "expense",
        amount: "1.00",
      })
    );

    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
    expect(mocks.revalidated).not.toContain("/");
  });
});

// ============================================================
// Idempotency
// ============================================================

describe("idempotency", () => {
  it("treats an identical retry of the same key as one row and one success", async () => {
    // The lost-response case: the row was written, the person never saw the
    // confirmation, and pressing the button again is the only sensible thing
    // they can do. It must not produce a second coffee.
    const account = await accountByName("Everyday Checking");
    const key = randomUUID();
    const fields = {
      id: key,
      accountId: account.id,
      date: shiftCalendarDate(today, -4),
      merchant: "CP3 Idempotent",
      kind: "expense",
      categoryId: "",
      amount: "9.99",
    };

    const first = await actions.createTransactionAction(IDLE, formData(fields));
    expect(first.status).toBe("success");

    const retry = await actions.createTransactionAction(IDLE, formData(fields));
    expect(retry.status).toBe("success");
    expect(retry.formError).toBeNull();

    const matching = (await getTransactions()).filter((t) => t.merchant === "CP3 Idempotent");
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(key);
    expect(matching[0].amountCents).toBe(-999);
  });

  it("refuses the same key with a different payload, and changes nothing", async () => {
    // The other half, and the reason a bare "23505 means success" would be
    // wrong: reporting success here would tell the person their edit was saved
    // while the stored row still held the original values.
    const account = await accountByName("Everyday Checking");
    const key = randomUUID();
    const base = {
      id: key,
      accountId: account.id,
      date: shiftCalendarDate(today, -5),
      merchant: "CP3 Conflicting",
      kind: "expense",
      categoryId: "",
      amount: "20.00",
    };

    expect((await actions.createTransactionAction(IDLE, formData(base))).status).toBe("success");

    // Cleared so the assertion below is about the *refused* retry.
    mocks.revalidated = [];

    const conflicting = await actions.createTransactionAction(
      IDLE,
      formData({ ...base, amount: "30.00" })
    );

    expect(conflicting.status).toBe("error");
    expect(conflicting.formError).toMatch(/already saved/i);
    expect(mocks.revalidated).toEqual([]);

    const stored = await transactionById(key);
    expect(stored!.amountCents).toBe(-2000);
    expect((await getTransactions()).filter((t) => t.id === key)).toHaveLength(1);
  });

  it("treats a merchant-only difference as a conflict too — the whole payload is compared", async () => {
    // Comparing a subset would make some edited resubmission silently
    // indistinguishable from a retry.
    const account = await accountByName("Everyday Checking");
    const key = randomUUID();
    const base = {
      id: key,
      accountId: account.id,
      date: shiftCalendarDate(today, -6),
      merchant: "CP3 Payload A",
      kind: "expense",
      categoryId: "",
      amount: "7.00",
    };

    expect((await actions.createTransactionAction(IDLE, formData(base))).status).toBe("success");

    const conflicting = await actions.createTransactionAction(
      IDLE,
      formData({ ...base, merchant: "CP3 Payload B" })
    );

    expect(conflicting.status).toBe("error");
    expect((await transactionById(key))!.merchant).toBe("CP3 Payload A");
  });
});

// ============================================================
// Edit
// ============================================================

describe("updateTransactionAction", () => {
  it("edits every editable field of an owned ordinary transaction", async () => {
    const account = await accountByName("Everyday Checking");
    const groceries = await categoryByName("Groceries");
    const dining = await categoryByName("Dining");
    const id = randomUUID();

    await actions.createTransactionAction(
      IDLE,
      createForm({
        id,
        accountId: account.id,
        merchant: "CP3 Before Edit",
        kind: "expense",
        categoryId: groceries.id,
        amount: "10.00",
      })
    );

    mocks.revalidated = [];

    const state = await actions.updateTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: shiftCalendarDate(today, -1),
        merchant: "CP3 After Edit",
        kind: "refund",
        categoryId: dining.id,
        amount: "3.25",
      })
    );

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);

    const stored = await transactionById(id);
    expect(stored!.merchant).toBe("CP3 After Edit");
    expect(stored!.kind).toBe("refund");
    // Retyped expense → refund, so the sign flips with the kind.
    expect(stored!.amountCents).toBe(325);
    expect(stored!.categoryId).toBe(dining.id);
    expect(stored!.date).toBe(shiftCalendarDate(today, -1));
  });

  it("refuses an edit that would date the row in the owner's future", async () => {
    const account = await accountByName("Everyday Checking");
    const id = randomUUID();

    await actions.createTransactionAction(
      IDLE,
      createForm({ id, accountId: account.id, merchant: "CP3 Stays Put", kind: "expense", amount: "4.00" })
    );

    const state = await actions.updateTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: shiftCalendarDate(today, 1),
        merchant: "CP3 Stays Put",
        kind: "expense",
        categoryId: "",
        amount: "4.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.date?.length).toBeGreaterThan(0);
    expect((await transactionById(id))!.date).toBe(shiftCalendarDate(today, -3));
  });

  it("refuses moving a transaction onto an archived account", async () => {
    const account = await accountByName("Everyday Checking");
    const archived = (await getAccounts()).find((a) => a.isArchived)!;
    const id = randomUUID();

    await actions.createTransactionAction(
      IDLE,
      createForm({ id, accountId: account.id, merchant: "CP3 No Archive Move", kind: "expense", amount: "6.00" })
    );

    const state = await actions.updateTransactionAction(
      IDLE,
      formData({
        id,
        accountId: archived.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP3 No Archive Move",
        kind: "expense",
        categoryId: "",
        amount: "6.00",
      })
    );

    expect(state.status).toBe("error");
    expect((await transactionById(id))!.accountId).toBe(account.id);
  });

  it("cannot edit a movement leg through the ordinary surface", async () => {
    // A transfer or card payment is a *pair* of rows. Editing one alone would
    // leave the movement invalid — the database makes legs invisible to this
    // statement entirely, and the DAL refuses before it gets there.
    const leg = (await getTransactions()).find((t) => t.movementId !== undefined);
    expect(leg, "the seed should provide movement legs").toBeDefined();

    const account = await accountByName("Everyday Checking");
    const state = await actions.updateTransactionAction(
      IDLE,
      formData({
        id: leg!.id,
        accountId: account.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP3 Hijacked Leg",
        kind: "expense",
        categoryId: "",
        amount: "1.00",
      })
    );

    expect(state.status).toBe("error");
    const after = await transactionById(leg!.id);
    expect(after!.merchant).toBe(leg!.merchant);
    expect(after!.amountCents).toBe(leg!.amountCents);
    expect(after!.movementId).toBe(leg!.movementId);
  });
});

// ============================================================
// Balances and KPIs
// ============================================================

describe("balances and derived figures move with the ledger", () => {
  it("moves a transaction between two accounts and updates both balances", async () => {
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");

    const fromBefore = from.balanceCents;
    const toBefore = to.balanceCents;

    const id = randomUUID();
    await actions.createTransactionAction(
      IDLE,
      createForm({ id, accountId: from.id, merchant: "CP3 Moves Accounts", kind: "expense", amount: "100.00" })
    );

    expect((await accountByName("Everyday Checking")).balanceCents).toBe(fromBefore - 10_000);
    expect((await accountByName("High-Yield Savings")).balanceCents).toBe(toBefore);

    await actions.updateTransactionAction(
      IDLE,
      formData({
        id,
        accountId: to.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP3 Moves Accounts",
        kind: "expense",
        categoryId: "",
        amount: "100.00",
      })
    );

    // The whole point: the derived balance is opening + SUM(ledger), so moving
    // one row restates both accounts in a single write.
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(fromBefore);
    expect((await accountByName("High-Yield Savings")).balanceCents).toBe(toBefore - 10_000);
  });

  it("feeds the dashboard's income, spending, cash-flow and category figures", async () => {
    const account = await accountByName("Everyday Checking");
    const salary = await categoryByName("Salary");
    const groceries = await categoryByName("Groceries");
    const month = monthKey(today);

    const before = await getTransactions({ month });
    const incomeBefore = monthlyIncome(before, month);
    const spendingBefore = monthlySpending(before, month);
    const cashFlowBefore = monthlyCashFlow(before, month);
    const groceriesBefore =
      spendingByCategory(before, month).find((c) => c.categoryId === groceries.id)?.amountCents ?? 0;

    await actions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "CP3 KPI Income",
        kind: "income",
        categoryId: salary.id,
        amount: "200.00",
      })
    );
    await actions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "CP3 KPI Spend",
        kind: "expense",
        categoryId: groceries.id,
        amount: "80.00",
      })
    );

    const after = await getTransactions({ month });

    expect(monthlyIncome(after, month)).toBe(incomeBefore + 20_000);
    // Spending is a positive display magnitude, so it grows by the expense.
    expect(monthlySpending(after, month)).toBe(spendingBefore + 8_000);
    expect(monthlyCashFlow(after, month)).toBe(cashFlowBefore + 12_000);
    expect(
      spendingByCategory(after, month).find((c) => c.categoryId === groceries.id)!.amountCents
    ).toBe(groceriesBefore + 8_000);
  });

  it("keeps an adjustment out of income and spending if one ever exists", async () => {
    // Nothing in the application can create one — the ordinary form refuses the
    // kind and the database refuses the UPDATE — so this asserts the read-side
    // handling holds for a row this checkpoint deliberately cannot produce.
    const month = monthKey(today);
    const rows = await getTransactions({ month });
    const adjustments = rows.filter((t) => t.kind === "adjustment");

    expect(adjustments).toHaveLength(0);
    // And the finance layer would exclude one regardless: the assertion above
    // documents that CP3 writes none, while lib/finance/transactions.test.ts
    // covers the exclusion itself.
  });
});

// ============================================================
// Delete
// ============================================================

describe("deleteTransactionAction", () => {
  it("deletes an owned ordinary transaction and reverses its effect on the balance", async () => {
    const account = await accountByName("Everyday Checking");
    const before = account.balanceCents;
    const id = randomUUID();

    await actions.createTransactionAction(
      IDLE,
      createForm({ id, accountId: account.id, merchant: "CP3 To Delete", kind: "expense", amount: "55.00" })
    );
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(before - 5_500);

    mocks.revalidated = [];

    const state = await actions.deleteTransactionAction(IDLE, formData({ id }));

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(TRANSACTION_ROUTES);
    expect(await transactionById(id)).toBeUndefined();
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(before);
  });

  it("refuses to delete a transaction a paid bill occurrence points at", async () => {
    // The deferred FK would refuse it at COMMIT with a bare 23503; the preflight
    // exists so the person is told what to actually do about it.
    const { data, error } = await context.client
      .from("bill_occurrences")
      .select("transaction_id")
      .eq("user_id", context.ownerId)
      .eq("status", "paid")
      .not("transaction_id", "is", null)
      .limit(1);

    expect(error).toBeNull();
    const linkedId = (data as { transaction_id: string }[])[0]?.transaction_id;
    expect(linkedId, "the seed should provide a paid occurrence with a transaction").toBeDefined();

    const state = await actions.deleteTransactionAction(IDLE, formData({ id: linkedId }));

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/unmark that bill as paid/i);
    expect(mocks.revalidated).toEqual([]);
    // Still there.
    expect(await transactionById(linkedId)).toBeDefined();
  });

  it("cannot delete a movement leg through the ordinary surface", async () => {
    const leg = (await getTransactions()).find((t) => t.movementId !== undefined)!;

    const state = await actions.deleteTransactionAction(IDLE, formData({ id: leg.id }));

    expect(state.status).toBe("error");
    expect(await transactionById(leg.id)).toBeDefined();

    // And its partner is untouched, which is the reason legs are protected at
    // all: removing one half would strand the other.
    const partners = (await getTransactions()).filter((t) => t.movementId === leg.movementId);
    expect(partners).toHaveLength(2);
  });

  it("reports a transaction that no longer exists rather than silently succeeding", async () => {
    const state = await actions.deleteTransactionAction(IDLE, formData({ id: randomUUID() }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });
});
