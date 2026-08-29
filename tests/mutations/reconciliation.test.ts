import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { IDLE, RECONCILIATION_ROUTES, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Reconciliation, end to end: real Server Actions → real validation → real
 * mutation DAL → the real `public.reconcile_account` RPC against real local
 * Supabase (RLS on, ordinary `authenticated` JWT) → read back through the real
 * production read DAL.
 *
 * ## What this proves that nothing else can
 *
 * `npm test` proves the schemas in isolation. `npm run db:test` proves the
 * function, the grants and the policies in isolation. Neither proves they are
 * *wired together* — that the action reads the account's stored type before it
 * decides whether a minus sign is legal, that "$450 owed" on a credit card
 * becomes a desired internal balance of -45000 and not +45000, that the
 * resulting balance lands exactly on the observed figure, that the adjustment
 * is visible to the production read path afterwards, and that not one economic
 * total moved.
 *
 * That last one is the point of the whole checkpoint. An adjustment must change
 * the balance and net worth while changing no income, no spending, no cash
 * flow and no category rollup — and "excluded by kind" is a claim about three
 * different layers agreeing, which only a test spanning all three can check.
 *
 * `getToday()` is deliberately **not** mocked, so the posted-date ceiling
 * exercised here is the real one, derived from the owner's own
 * `profiles.timezone`.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as unknown,
  ownerId: "" as string,
  revalidated: [] as string[],
  redirectedTo: null as string | null,
}));

// The one seam lib/data/** uses to reach the database. Everything downstream of
// it — mappers, query builders, preflights, error mapping, the clock, the RPC
// calls — is real.
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

const actions = await import("@/lib/actions/reconciliation");
const accountActions = await import("@/lib/actions/accounts");
const transactionActions = await import("@/lib/actions/transactions");
const { getAccounts } = await import("@/lib/data/accounts");
const { getToday } = await import("@/lib/data/clock");
const { getTransactions } = await import("@/lib/data/transactions");
const { monthlyIncome, monthlySpending, monthlyCashFlow, spendingByCategory } = await import(
  "@/lib/finance/transactions"
);
const { netWorth, totalAssets, totalLiabilities } = await import("@/lib/finance/accounts");
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

async function balanceOf(accountId: string): Promise<number> {
  return (await getAccounts()).find((a) => a.id === accountId)!.balanceCents;
}

/** Every adjustment currently in the ledger, newest first, through the read DAL. */
async function adjustments() {
  return (await getTransactions({ kind: "adjustment" })).filter((t) => t.kind === "adjustment");
}

/** The adjustments on one account. */
async function adjustmentsOn(accountId: string) {
  return (await adjustments()).filter((t) => t.accountId === accountId);
}

/** A complete reconcile submission, dated today unless overridden. */
function reconcileForm(fields: Record<string, string>): FormData {
  return formData({ asOf: today, ...fields });
}

// ============================================================
// Asset accounts — a signed actual balance
// ============================================================

describe("reconcileAccountAction — asset accounts", () => {
  it("reconciles downward and lands the balance exactly on the observed figure", async () => {
    const account = await accountByName("Everyday Checking");
    const before = await adjustmentsOn(account.id);
    const target = account.balanceCents - 5_000; // $50 less than this app thinks

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({
        accountId: account.id,
        balance: centsToInput(target),
      })
    );

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();

    // The property the whole feature exists for: after reconciling, the derived
    // balance *is* the figure the person read off their statement.
    expect(await balanceOf(account.id)).toBe(target);

    // Counted relative to what was already there rather than from zero: Vitest
    // does not guarantee the order test *files* run in, so another file may
    // legitimately have reconciled this account first.
    const after = await adjustmentsOn(account.id);
    expect(after).toHaveLength(before.length + 1);

    const written = after.find((t) => !before.some((b) => b.id === t.id))!;
    expect(written).toBeDefined();
    expect(written.amountCents).toBe(-5_000);
    expect(written.date).toBe(today);
    // Shape: no category, no movement, a deterministic label the client never
    // supplied.
    expect(written.categoryId).toBeUndefined();
    expect(written.movementId).toBeUndefined();
    expect(written.merchant).toBe("Balance adjustment");
  });

  it("reconciles upward, from the already-adjusted balance", async () => {
    // The account already carries the adjustment written above, so this proves
    // the delta is computed against current state rather than against an
    // opening figure or a stale read.
    const account = await accountByName("Everyday Checking");
    const before = await adjustmentsOn(account.id);
    expect(before.length).toBeGreaterThan(0);
    const target = account.balanceCents + 12_345;

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(target) })
    );

    expect(state.status).toBe("success");
    expect(await balanceOf(account.id)).toBe(target);

    const after = await adjustmentsOn(account.id);
    expect(after).toHaveLength(before.length + 1);
    // The stack of adjustments sums to the difference between where the
    // account's ledger would have left it and where it now stands.
    expect(after.reduce((sum, t) => sum + t.amountCents, 0)).toBe(
      before.reduce((sum, t) => sum + t.amountCents, 0) + 12_345
    );
  });

  it("accepts a negative observed balance — an overdrawn account is a real state", async () => {
    const account = await accountByName("Cash Wallet");

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: "-25.00" })
    );

    expect(state.status).toBe("success");
    expect(await balanceOf(account.id)).toBe(-2_500);
  });

  it("writes nothing when the balance already matches, and still reports success", async () => {
    const account = await accountByName("Brokerage Account");
    const before = await adjustmentsOn(account.id);

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(account.balanceCents) })
    );

    // A zero delta is a successful reconciliation, deliberately
    // indistinguishable from one that wrote a row: in both cases the balance
    // now equals what the person said it was.
    expect(state.status).toBe("success");
    expect(await adjustmentsOn(account.id)).toHaveLength(before.length);
    expect(await balanceOf(account.id)).toBe(account.balanceCents);
  });

  it("is idempotent under resubmission, without an idempotency key", async () => {
    // The second submission computes its delta against the balance the first
    // one already corrected, so it writes nothing. That is why reconciliation
    // needs no client-minted UUID, unlike CP3's and CP4's creates.
    const account = await accountByName("High-Yield Savings");
    const existing = await adjustmentsOn(account.id);
    const target = account.balanceCents - 9_900;
    const form = reconcileForm({ accountId: account.id, balance: centsToInput(target) });

    const first = await actions.reconcileAccountAction(IDLE, form);
    const second = await actions.reconcileAccountAction(IDLE, form);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    // One new adjustment between the two submissions, not two.
    expect(await adjustmentsOn(account.id)).toHaveLength(existing.length + 1);
    expect(await balanceOf(account.id)).toBe(target);
  });

  it("revalidates exactly the four routes a reconciliation changes", async () => {
    const account = await accountByName("Everyday Checking");
    mocks.revalidated = [];

    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(account.balanceCents - 100) })
    );

    expect(mocks.revalidated).toEqual(RECONCILIATION_ROUTES);
    // `/budgets` is excluded on purpose: an adjustment is excluded from
    // `countsAsSpending` by kind, so no budget figure can move.
    expect(mocks.revalidated).not.toContain("/budgets");
  });
});

// ============================================================
// Liability accounts — a non-negative amount owed
// ============================================================

describe("reconcileAccountAction — credit and loan accounts", () => {
  it("turns a positive 'amount owed' into a negative internal balance", async () => {
    // The worked example from the checkpoint brief, against the real seed:
    // whatever the card currently owes, saying "I owe $450" must leave the
    // stored balance at exactly -45000 — never +45000, and never the delta.
    const card = await accountByName("Rewards Credit Card");
    expect(card.type).toBe("credit");

    const existing = await adjustmentsOn(card.id);
    const expectedDelta = -45_000 - card.balanceCents;

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: card.id, balance: "450.00" })
    );

    expect(state.status).toBe("success");
    expect(await balanceOf(card.id)).toBe(-45_000);

    const written = await adjustmentsOn(card.id);
    expect(written).toHaveLength(existing.length + 1);
    expect(written.find((t) => !existing.some((e) => e.id === t.id))!.amountCents).toBe(
      expectedDelta
    );
  });

  it("treats zero owed as a zero internal balance, not as 'no change'", async () => {
    const loan = await accountByName("Auto Loan");
    expect(loan.type).toBe("loan");
    expect(loan.balanceCents).toBeLessThan(0);

    const existing = await adjustmentsOn(loan.id);

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: loan.id, balance: "0" })
    );

    expect(state.status).toBe("success");
    // Exactly 0, and exactly +0 — a stored `-0` would be `=== 0` and would
    // still serialize as "-0".
    expect(await balanceOf(loan.id)).toBe(0);
    expect(Object.is(await balanceOf(loan.id), 0)).toBe(true);

    const written = await adjustmentsOn(loan.id);
    expect(written).toHaveLength(existing.length + 1);
    expect(written.find((t) => !existing.some((e) => e.id === t.id))!.amountCents).toBeGreaterThan(
      0
    );
  });

  it("refuses a negative amount owed, as a field error on the balance", async () => {
    // Nobody should have to know that a liability is stored negative, so the
    // field asks for a magnitude — and a minus sign in it is a mistake, not an
    // instruction. The schema knows which question was asked because the action
    // read the account's *stored* type first.
    const card = await accountByName("Rewards Credit Card");
    const existing = await adjustmentsOn(card.id);

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: card.id, balance: "-100.00" })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.balance).toEqual(["Enter an amount of zero or more."]);
    // Nothing was written.
    expect(await adjustmentsOn(card.id)).toHaveLength(existing.length);
    expect(await balanceOf(card.id)).toBe(card.balanceCents);
  });

  it("still accepts a negative balance on an asset account — the rule is per type", async () => {
    // The mirror of the assertion above, so "liabilities refuse a minus sign"
    // cannot be satisfied by a schema that refuses one everywhere.
    const account = await accountByName("Cash Wallet");
    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: "-1.00" })
    );

    expect(state.status).toBe("success");
    expect(await balanceOf(account.id)).toBe(-100);
  });
});

// ============================================================
// Finance semantics — the reason adjustments exist as their own kind
// ============================================================

describe("an adjustment moves balances and no economic figure", () => {
  it("changes net worth and the account balance, and nothing else", async () => {
    const account = await accountByName("Everyday Checking");
    const month = monthKey(today);

    const accountsBefore = await getAccounts();
    const netWorthBefore = netWorth(accountsBefore);
    const assetsBefore = totalAssets(accountsBefore);
    const liabilitiesBefore = totalLiabilities(accountsBefore);

    const rowsBefore = await getTransactions({ month });
    const incomeBefore = monthlyIncome(rowsBefore, month);
    const spendingBefore = monthlySpending(rowsBefore, month);
    const cashFlowBefore = monthlyCashFlow(rowsBefore, month);
    const categoriesBefore = spendingByCategory(rowsBefore, month);

    const delta = -7_500;

    const state = await actions.reconcileAccountAction(
      IDLE,
      // Dated inside the month under test, so an unchanged figure below cannot
      // be explained by the row falling outside the window.
      reconcileForm({
        accountId: account.id,
        balance: centsToInput(account.balanceCents + delta),
      })
    );
    expect(state.status).toBe("success");

    const rowsAfter = await getTransactions({ month });
    // The adjustment really is among the month's rows — otherwise the
    // "unchanged" assertions below would prove nothing.
    expect(rowsAfter.length).toBe(rowsBefore.length + 1);
    expect(rowsAfter.some((t) => t.kind === "adjustment" && t.amountCents === delta)).toBe(true);

    // Balances moved…
    const accountsAfter = await getAccounts();
    expect(accountsAfter.find((a) => a.id === account.id)!.balanceCents).toBe(
      account.balanceCents + delta
    );
    expect(netWorth(accountsAfter)).toBe(netWorthBefore + delta);
    expect(totalAssets(accountsAfter)).toBe(assetsBefore + delta);
    expect(totalLiabilities(accountsAfter)).toBe(liabilitiesBefore);

    // …and not one economic figure did.
    expect(monthlyIncome(rowsAfter, month)).toBe(incomeBefore);
    expect(monthlySpending(rowsAfter, month)).toBe(spendingBefore);
    expect(monthlyCashFlow(rowsAfter, month)).toBe(cashFlowBefore);
    expect(spendingByCategory(rowsAfter, month)).toEqual(categoriesBefore);
  });

  it("moves a liability total when the reconciled account is a card", async () => {
    const card = await accountByName("Rewards Credit Card");
    const accountsBefore = await getAccounts();
    const liabilitiesBefore = totalLiabilities(accountsBefore);
    const assetsBefore = totalAssets(accountsBefore);

    // Owe $100 more than this application knew about.
    const owedNow = -card.balanceCents + 10_000;
    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: card.id, balance: centsToInput(owedNow) })
    );

    const accountsAfter = await getAccounts();
    expect(totalLiabilities(accountsAfter)).toBe(liabilitiesBefore + 10_000);
    expect(totalAssets(accountsAfter)).toBe(assetsBefore);
    expect(netWorth(accountsAfter)).toBe(netWorth(accountsBefore) - 10_000);
  });
});

// ============================================================
// Refusals
// ============================================================

describe("reconcileAccountAction — what it refuses", () => {
  it("refuses an as-of date in the owner's future, as a field error", async () => {
    const account = await accountByName("Everyday Checking");
    const before = await balanceOf(account.id);

    const state = await actions.reconcileAccountAction(
      IDLE,
      formData({
        accountId: account.id,
        asOf: shiftCalendarDate(today, 1),
        balance: "1.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.asOf).toEqual(["That date is in the future."]);
    expect(await balanceOf(account.id)).toBe(before);
  });

  it("refuses an archived account", async () => {
    const archived = (await getAccounts()).find((a) => a.isArchived);
    expect(archived, "the seed should provide an archived account").toBeDefined();

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: archived!.id, balance: "1.00" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toContain("no longer be reconciled");
    expect(await adjustmentsOn(archived!.id)).toHaveLength(0);
  });

  it("refuses an account id that is not the owner's", async () => {
    // The mutation suite authenticates as one owner, so a foreign account is
    // represented by an id RLS makes invisible — which is exactly what another
    // owner's account looks like from here, and deliberately
    // indistinguishable from one that does not exist. The genuine two-owner
    // case is proved in supabase/tests/database/150-reconciliation.sql.
    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: randomUUID(), balance: "1.00" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });

  it("refuses a malformed account id before touching the database", async () => {
    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: "", balance: "1.00" })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });

  it("never leaks an amount, a balance or a driver message into the form state", async () => {
    const archived = (await getAccounts()).find((a) => a.isArchived)!;

    const state = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: archived.id, balance: "1234.56" })
    );

    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/reconcile_account/);
    expect(serialized).not.toMatch(/23514|22003|PGRST/);
    expect(serialized).not.toMatch(/balance_cents|amount_cents/);
    // The echoed `values` legitimately contain what the person typed — that is
    // their own input, not data the server disclosed.
    expect(state.values?.balance).toBe("1234.56");
  });
});

// ============================================================
// The adjustment lifecycle
// ============================================================

describe("adjustments cannot be edited through the ordinary surface", () => {
  it("refuses an ordinary update targeting an adjustment", async () => {
    const account = await accountByName("Everyday Checking");
    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput((await balanceOf(account.id)) - 333) })
    );

    const adjustment = (await adjustmentsOn(account.id)).find((t) => t.amountCents === -333);
    expect(adjustment).toBeDefined();

    const state = await transactionActions.updateTransactionAction(
      IDLE,
      formData({
        id: adjustment!.id,
        accountId: account.id,
        date: today,
        merchant: "Rewritten",
        kind: "expense",
        amount: "1.00",
      })
    );

    expect(state.status).toBe("error");

    // Byte for byte, still what reconciliation wrote.
    const after = (await adjustmentsOn(account.id)).find((t) => t.id === adjustment!.id);
    expect(after).toBeDefined();
    expect(after!.kind).toBe("adjustment");
    expect(after!.merchant).toBe("Balance adjustment");
    expect(after!.amountCents).toBe(-333);
  });

  it("refuses to retype an ordinary transaction into an adjustment", async () => {
    // From the other direction: the ordinary schema's kind is narrowed to
    // income/expense/refund, so `adjustment` is not even spellable there. The
    // database refuses it independently via
    // `transactions_update_own_ordinary`'s WITH CHECK.
    const account = await accountByName("Everyday Checking");
    const ordinary = (await getTransactions({ kind: "expense" }))[0];
    expect(ordinary).toBeDefined();

    const state = await transactionActions.updateTransactionAction(
      IDLE,
      formData({
        id: ordinary.id,
        accountId: ordinary.accountId,
        date: ordinary.date,
        merchant: ordinary.merchant,
        kind: "adjustment",
        amount: "1.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.kind).toBeDefined();

    const after = (await getTransactions({ kind: "expense" })).find((t) => t.id === ordinary.id);
    expect(after?.kind).toBe("expense");
    expect(account).toBeDefined();
  });
});

describe("deleteAdjustmentAction", () => {
  it("reverses the reconciliation it undoes, exactly", async () => {
    const account = await accountByName("High-Yield Savings");
    const before = await balanceOf(account.id);

    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(before - 4_242) })
    );
    expect(await balanceOf(account.id)).toBe(before - 4_242);

    const adjustment = (await adjustmentsOn(account.id)).find((t) => t.amountCents === -4_242);
    expect(adjustment).toBeDefined();

    mocks.revalidated = [];
    const state = await actions.deleteAdjustmentAction(IDLE, formData({ id: adjustment!.id }));

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(RECONCILIATION_ROUTES);
    // Back to exactly where it started — which is what makes
    // remove-and-reconcile-again a real correction path rather than an
    // approximation.
    expect(await balanceOf(account.id)).toBe(before);
    expect((await adjustmentsOn(account.id)).some((t) => t.id === adjustment!.id)).toBe(false);
  });

  it("refuses an ordinary transaction — this path is not a second delete surface", async () => {
    const ordinary = (await getTransactions({ kind: "expense" }))[0];
    expect(ordinary).toBeDefined();

    const state = await actions.deleteAdjustmentAction(IDLE, formData({ id: ordinary.id }));

    expect(state.status).toBe("error");
    expect(state.formError).toContain("Only a balance adjustment");

    const after = (await getTransactions({ kind: "expense" })).find((t) => t.id === ordinary.id);
    expect(after).toBeDefined();
  });

  it("refuses a movement leg", async () => {
    const leg = (await getTransactions({ kind: "transfer" }))[0];
    expect(leg).toBeDefined();

    const state = await actions.deleteAdjustmentAction(IDLE, formData({ id: leg.id }));

    expect(state.status).toBe("error");
    expect(state.formError).toContain("Only a balance adjustment");
    expect((await getTransactions({ kind: "transfer" })).some((t) => t.id === leg.id)).toBe(true);
  });

  it("refuses an id that is not the owner's", async () => {
    const state = await actions.deleteAdjustmentAction(IDLE, formData({ id: randomUUID() }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });

  it("allows reconciling again after an undo, landing on the new figure", async () => {
    const account = await accountByName("High-Yield Savings");
    const start = await balanceOf(account.id);

    // A reconciliation to the wrong figure…
    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(start - 100_000) })
    );
    const wrong = (await adjustmentsOn(account.id)).find((t) => t.amountCents === -100_000)!;

    // …removed…
    expect((await actions.deleteAdjustmentAction(IDLE, formData({ id: wrong.id }))).status).toBe(
      "success"
    );
    expect(await balanceOf(account.id)).toBe(start);

    // …and re-run correctly. This is the whole supported correction path, and
    // it is why an adjustment is deletable while being permanently uneditable.
    await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: centsToInput(start - 250) })
    );
    expect(await balanceOf(account.id)).toBe(start - 250);
  });
});

// ============================================================
// The reconciled account can then be archived
// ============================================================

describe("reconciliation composes with the rest of the write surface", () => {
  it("lets an account reconciled to zero be archived, then unarchived", async () => {
    // Not a contrived combination: CP2's `accounts_guard_update()` only permits
    // archiving once the derived balance is exactly zero, and before CP5 the
    // only way to reach zero was to enter offsetting transactions by hand.
    const account = await accountByName("Cash Wallet");

    const reconciled = await actions.reconcileAccountAction(
      IDLE,
      reconcileForm({ accountId: account.id, balance: "0" })
    );
    expect(reconciled.status).toBe("success");
    expect(await balanceOf(account.id)).toBe(0);

    const archived = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "true" })
    );
    expect(archived.status).toBe("success");
    expect((await getAccounts()).find((a) => a.id === account.id)!.isArchived).toBe(true);

    const restored = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "false" })
    );
    expect(restored.status).toBe("success");
    expect((await getAccounts()).find((a) => a.id === account.id)!.isArchived).toBe(false);
  });
});

/**
 * Cents → the decimal string the form field carries.
 *
 * A local helper rather than an import from `lib/format/currency.ts`: these
 * tests drive the *form*, so they should build the same text a person would
 * type, and going through the production formatter would make a formatting bug
 * cancel itself out on both sides of the assertion.
 */
function centsToInput(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}
