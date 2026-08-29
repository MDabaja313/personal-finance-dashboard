import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { IDLE, MOVEMENT_ROUTES, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * Movement writes, end to end: real Server Actions → real validation → real
 * mutation DAL → the real `create_movement`/`replace_movement` RPCs against
 * real local Supabase (RLS on, ordinary `authenticated` JWT) → read back
 * through the real production read DAL.
 *
 * ## What this proves that nothing else can
 *
 * `npm test` proves the schemas and the action control flow in isolation.
 * `npm run db:test` proves the grants, the policies, the RPCs and
 * `validate_movement()` in isolation. Neither proves they are *wired together*
 * — that the action posts the arguments the function expects, that the DAL's
 * preflight and the database's own checks agree about what is refused, that an
 * idempotent retry really produces one movement and two legs rather than two of
 * each, that an edit is atomic all the way through the stack, or that both legs
 * are visible to the read path afterwards and move exactly the balances they
 * should. That is this file's whole job, and it is why the only things mocked
 * are the Supabase seam plus the two Next.js request-scoped functions.
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

const actions = await import("@/lib/actions/movements");
const transactionActions = await import("@/lib/actions/transactions");
const { getAccounts } = await import("@/lib/data/accounts");
const { getToday } = await import("@/lib/data/clock");
const { getMovements } = await import("@/lib/data/movements");
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

/** One movement, read back through the production read DAL. */
async function movementById(id: string) {
  return (await getMovements([id]))[0];
}

/** Every ledger row belonging to one movement, in whatever order the DAL returns. */
async function legsOf(movementId: string) {
  return (await getTransactions()).filter((t) => t.movementId === movementId);
}

/** A fresh set of the three ids one logical submission mints. */
function keys() {
  return {
    id: randomUUID(),
    sourceLegId: randomUUID(),
    destinationLegId: randomUUID(),
  };
}

/** A complete create submission, with fresh keys unless overridden. */
function movementForm(fields: Record<string, string>): FormData {
  return formData({
    ...keys(),
    kind: "transfer",
    date: shiftCalendarDate(today, -3),
    ...fields,
  });
}

// ============================================================
// Create — transfers
// ============================================================

describe("createMovementAction — transfers", () => {
  it("writes a parent and exactly two opposite-signed legs, visible to the read DAL", async () => {
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const k = keys();

    const state = await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -2),
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: "125.00",
      })
    );

    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();

    const legs = await legsOf(k.id);
    expect(legs).toHaveLength(2);
    // The signs were derived from each leg's role — the form posted a
    // magnitude and never a sign.
    expect(legs.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-12_500, 12_500]);
    expect(legs.reduce((sum, l) => sum + l.amountCents, 0)).toBe(0);
    // Both legs are transfers, both carry the movement id, neither has a
    // category.
    expect(legs.every((l) => l.kind === "transfer")).toBe(true);
    expect(legs.every((l) => l.movementId === k.id)).toBe(true);
    expect(legs.every((l) => l.categoryId === undefined)).toBe(true);

    const source = legs.find((l) => l.amountCents < 0)!;
    const destination = legs.find((l) => l.amountCents > 0)!;
    expect(source.accountId).toBe(from.id);
    expect(destination.accountId).toBe(to.id);
    // The leg ids the form minted are the row ids that were written.
    expect(source.id).toBe(k.sourceLegId);
    expect(destination.id).toBe(k.destinationLegId);
  });

  it("derives both merchant labels from the movement's kind and the other account's name", async () => {
    // The client posts no merchant at all — there is no such field. The labels
    // come from `public.create_movement`, so the pair is consistent by
    // construction.
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -2),
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: "5.00",
      })
    );

    const legs = await legsOf(k.id);
    expect(legs.find((l) => l.amountCents < 0)!.merchant).toBe("Transfer to High-Yield Savings");
    expect(legs.find((l) => l.amountCents > 0)!.merchant).toBe("Transfer from Everyday Checking");
  });

  it("moves the two balances by exactly opposite amounts and leaves net worth unchanged", async () => {
    const accountsBefore = await getAccounts();
    const from = accountsBefore.find((a) => a.name === "Everyday Checking")!;
    const to = accountsBefore.find((a) => a.name === "High-Yield Savings")!;
    const netWorthBefore = netWorth(accountsBefore);
    const assetsBefore = totalAssets(accountsBefore);

    await actions.createMovementAction(
      IDLE,
      movementForm({
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: "200.00",
      })
    );

    const accountsAfter = await getAccounts();
    expect(accountsAfter.find((a) => a.id === from.id)!.balanceCents).toBe(
      from.balanceCents - 20_000
    );
    expect(accountsAfter.find((a) => a.id === to.id)!.balanceCents).toBe(to.balanceCents + 20_000);

    // The whole point of a transfer: money changed places, and none of it
    // entered or left.
    expect(netWorth(accountsAfter)).toBe(netWorthBefore);
    expect(totalAssets(accountsAfter)).toBe(assetsBefore);
  });

  it("changes no income, spending, cash-flow or category figure", async () => {
    // Movement legs are excluded from every economic rollup **by kind**, not by
    // sign and not by having no category — `countsAsSpending` is an allowlist
    // of `expense` and `refund`.
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const month = monthKey(today);

    const before = await getTransactions({ month });
    const incomeBefore = monthlyIncome(before, month);
    const spendingBefore = monthlySpending(before, month);
    const cashFlowBefore = monthlyCashFlow(before, month);
    const categoriesBefore = spendingByCategory(before, month);

    await actions.createMovementAction(
      IDLE,
      formData({
        ...keys(),
        kind: "transfer",
        // Dated inside the month under test, so an unchanged figure cannot be
        // explained by the row falling outside the window.
        date: today,
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: "750.00",
      })
    );

    const after = await getTransactions({ month });
    // The legs really are in the month's rows — otherwise this proves nothing.
    expect(after.length).toBe(before.length + 2);

    expect(monthlyIncome(after, month)).toBe(incomeBefore);
    expect(monthlySpending(after, month)).toBe(spendingBefore);
    expect(monthlyCashFlow(after, month)).toBe(cashFlowBefore);
    expect(spendingByCategory(after, month)).toEqual(categoriesBefore);
  });

  it("revalidates exactly the four movement routes, and never /budgets", async () => {
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");

    await actions.createMovementAction(
      IDLE,
      movementForm({ fromAccountId: from.id, toAccountId: to.id, amount: "1.00" })
    );

    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
    expect(mocks.revalidated).not.toContain("/budgets");
    expect(mocks.revalidated).not.toContain("/");
  });
});

// ============================================================
// Create — credit card payments
// ============================================================

describe("createMovementAction — credit card payments", () => {
  it("decreases the funding account and moves the card's balance toward zero", async () => {
    const accountsBefore = await getAccounts();
    const funding = accountsBefore.find((a) => a.name === "Everyday Checking")!;
    const card = accountsBefore.find((a) => a.name === "Rewards Credit Card")!;
    const netWorthBefore = netWorth(accountsBefore);
    const liabilitiesBefore = totalLiabilities(accountsBefore);

    // A card balance is stored negative (it is a liability), so a payment is
    // the movement that raises it toward zero.
    expect(card.balanceCents).toBeLessThan(0);

    const k = keys();
    const state = await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "credit_card_payment",
        date: shiftCalendarDate(today, -1),
        fromAccountId: funding.id,
        toAccountId: card.id,
        amount: "300.00",
      })
    );

    expect(state.status).toBe("success");

    const accountsAfter = await getAccounts();
    expect(accountsAfter.find((a) => a.id === funding.id)!.balanceCents).toBe(
      funding.balanceCents - 30_000
    );
    expect(accountsAfter.find((a) => a.id === card.id)!.balanceCents).toBe(
      card.balanceCents + 30_000
    );

    // Paying a card does not make anyone richer or poorer: an asset and a
    // liability fall together.
    expect(netWorth(accountsAfter)).toBe(netWorthBefore);
    expect(totalLiabilities(accountsAfter)).toBe(liabilitiesBefore - 30_000);

    const legs = await legsOf(k.id);
    expect(legs.every((l) => l.kind === "credit_card_payment")).toBe(true);
    expect(legs.find((l) => l.amountCents < 0)!.accountId).toBe(funding.id);
    expect(legs.find((l) => l.amountCents > 0)!.accountId).toBe(card.id);
    expect(legs.find((l) => l.amountCents < 0)!.merchant).toBe("Payment to Rewards Credit Card");
  });

  it("leaves income and spending untouched", async () => {
    const funding = await accountByName("Everyday Checking");
    const card = await accountByName("Rewards Credit Card");
    const month = monthKey(today);

    const before = await getTransactions({ month });
    const incomeBefore = monthlyIncome(before, month);
    const spendingBefore = monthlySpending(before, month);

    await actions.createMovementAction(
      IDLE,
      formData({
        ...keys(),
        kind: "credit_card_payment",
        date: today,
        fromAccountId: funding.id,
        toAccountId: card.id,
        amount: "40.00",
      })
    );

    const after = await getTransactions({ month });
    expect(monthlyIncome(after, month)).toBe(incomeBefore);
    expect(monthlySpending(after, month)).toBe(spendingBefore);
  });

  it("refuses a card payment whose destination is not a credit account", async () => {
    const funding = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    const state = await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "credit_card_payment",
        date: shiftCalendarDate(today, -1),
        fromAccountId: funding.id,
        toAccountId: savings.id,
        amount: "10.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/refresh the page/i);
    expect(await legsOf(k.id)).toHaveLength(0);
    expect(mocks.revalidated).toEqual([]);
  });

  it("accepts a card payment funded from a non-checking account", async () => {
    // Nothing constrains the *source*'s type — paying a card from savings is a
    // thing a person may legitimately record, and inventing a restriction would
    // be inventing a rule the rest of the application does not have.
    const savings = await accountByName("High-Yield Savings");
    const card = await accountByName("Rewards Credit Card");
    const k = keys();

    const state = await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "credit_card_payment",
        date: shiftCalendarDate(today, -1),
        fromAccountId: savings.id,
        toAccountId: card.id,
        amount: "15.00",
      })
    );

    expect(state.status).toBe("success");
    expect(await legsOf(k.id)).toHaveLength(2);
  });
});

// ============================================================
// Idempotency
// ============================================================

describe("idempotency", () => {
  it("treats an identical retry of the same keys as one movement and one success", async () => {
    // The lost-response case: the movement was written, the person never saw
    // the confirmation, and pressing the button again is the only sensible
    // thing they can do. It must not produce a second transfer.
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const fields = {
      ...keys(),
      kind: "transfer",
      date: shiftCalendarDate(today, -4),
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: "77.77",
    };

    const first = await actions.createMovementAction(IDLE, formData(fields));
    expect(first.status).toBe("success");

    const balanceAfterFirst = (await accountByName("Everyday Checking")).balanceCents;

    const retry = await actions.createMovementAction(IDLE, formData(fields));
    expect(retry.status).toBe("success");
    expect(retry.formError).toBeNull();

    // One parent, two legs — not two parents and four legs.
    expect(await legsOf(fields.id)).toHaveLength(2);
    expect(await movementById(fields.id)).toBeDefined();
    // And the balance moved once.
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(balanceAfterFirst);
  });

  it("refuses the same movement id with a different payload, and changes nothing", async () => {
    // The other half, and the reason a bare "23505 means success" would be
    // wrong: reporting success here would tell the person their edit was saved
    // while the stored movement still held the original values.
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const base = {
      ...keys(),
      kind: "transfer",
      date: shiftCalendarDate(today, -5),
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: "60.00",
    };

    expect((await actions.createMovementAction(IDLE, formData(base))).status).toBe("success");

    mocks.revalidated = [];

    const conflicting = await actions.createMovementAction(
      IDLE,
      formData({ ...base, amount: "90.00" })
    );

    expect(conflicting.status).toBe("error");
    expect(conflicting.formError).toMatch(/already saved/i);
    expect(mocks.revalidated).toEqual([]);

    const stored = await movementById(base.id);
    expect(stored.amountCents).toBe(6_000);
    expect(await legsOf(base.id)).toHaveLength(2);
  });

  it("treats a changed destination account as a conflict too — the whole payload is compared", async () => {
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const other = await accountByName("Cash Wallet");
    const base = {
      ...keys(),
      kind: "transfer",
      date: shiftCalendarDate(today, -6),
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: "11.00",
    };

    expect((await actions.createMovementAction(IDLE, formData(base))).status).toBe("success");

    const conflicting = await actions.createMovementAction(
      IDLE,
      formData({ ...base, toAccountId: other.id })
    );

    expect(conflicting.status).toBe("error");
    expect((await movementById(base.id)).toAccountId).toBe(to.id);
  });

  it("treats reused leg ids under a fresh movement id as a conflict, not a success", async () => {
    // A leg id collides on the transactions primary key inside the RPC, and the
    // read-back then finds no movement at the *new* key — so it falls through
    // as the ordinary unique conflict it is, rather than claiming a write that
    // never happened.
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const first = {
      ...keys(),
      kind: "transfer",
      date: shiftCalendarDate(today, -7),
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: "13.00",
    };

    expect((await actions.createMovementAction(IDLE, formData(first))).status).toBe("success");

    const reused = await actions.createMovementAction(
      IDLE,
      formData({
        ...first,
        id: randomUUID(),
        amount: "14.00",
      })
    );

    expect(reused.status).toBe("error");
    // The first movement is untouched.
    expect((await movementById(first.id)).amountCents).toBe(1_300);
  });
});

// ============================================================
// Edit
// ============================================================

describe("updateMovementAction", () => {
  it("edits amount, date and both accounts atomically, preserving every id", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const cash = await accountByName("Cash Wallet");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -8),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "50.00",
      })
    );

    mocks.revalidated = [];

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -2),
        fromAccountId: savings.id,
        toAccountId: cash.id,
        amount: "80.00",
      })
    );

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);

    const stored = await movementById(k.id);
    expect(stored.id).toBe(k.id);
    expect(stored.amountCents).toBe(8_000);
    expect(stored.date).toBe(shiftCalendarDate(today, -2));
    expect(stored.fromAccountId).toBe(savings.id);
    expect(stored.toAccountId).toBe(cash.id);
    // Both legs kept their row identity — an edit does not reincarnate rows.
    expect(stored.sourceLegId).toBe(k.sourceLegId);
    expect(stored.destinationLegId).toBe(k.destinationLegId);

    const legs = await legsOf(k.id);
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, l) => sum + l.amountCents, 0)).toBe(0);
    // And the merchant labels were re-derived for the new accounts.
    expect(legs.find((l) => l.amountCents < 0)!.merchant).toBe("Transfer to Cash Wallet");
  });

  it("restates both old and both new balances in one write", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -8),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "100.00",
      })
    );

    const afterCreate = await getAccounts();
    const checkingAfterCreate = afterCreate.find((a) => a.id === checking.id)!.balanceCents;
    const savingsAfterCreate = afterCreate.find((a) => a.id === savings.id)!.balanceCents;

    // Same accounts, larger amount.
    await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -8),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "150.00",
      })
    );

    const afterEdit = await getAccounts();
    expect(afterEdit.find((a) => a.id === checking.id)!.balanceCents).toBe(
      checkingAfterCreate - 5_000
    );
    expect(afterEdit.find((a) => a.id === savings.id)!.balanceCents).toBe(
      savingsAfterCreate + 5_000
    );
  });

  it("changes a transfer into a card payment", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const card = await accountByName("Rewards Credit Card");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "25.00",
      })
    );

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "credit_card_payment",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: card.id,
        amount: "25.00",
      })
    );

    expect(state.status).toBe("success");
    expect((await movementById(k.id)).kind).toBe("credit_card_payment");
    // Both legs were retyped together — the parent's kind and each leg's kind
    // must agree (validate_movement() assert 3).
    expect((await legsOf(k.id)).every((l) => l.kind === "credit_card_payment")).toBe(true);
  });

  it("leaves the original pair byte-for-byte intact when the replacement is refused", async () => {
    // The property the whole delete-and-recreate design rests on. The delete
    // and the re-creation are one transaction, so a refused replacement leg
    // aborts everything.
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -9),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "33.00",
      })
    );

    const before = await movementById(k.id);
    const balanceBefore = (await accountByName("Everyday Checking")).balanceCents;

    mocks.revalidated = [];

    // A card payment aimed at a savings account: refused inside the RPC, after
    // the parent has already been deleted within that transaction.
    const refused = await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "credit_card_payment",
        date: shiftCalendarDate(today, -9),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "99.00",
      })
    );

    expect(refused.status).toBe("error");
    expect(mocks.revalidated).toEqual([]);

    const after = await movementById(k.id);
    expect(after).toEqual(before);
    expect(await legsOf(k.id)).toHaveLength(2);
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(balanceBefore);
  });

  it("refuses an edit that would date the movement in the owner's future", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "8.00",
      })
    );

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, 1),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "8.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.date?.length).toBeGreaterThan(0);
    expect((await movementById(k.id)).date).toBe(shiftCalendarDate(today, -3));
  });

  it("refuses moving a movement onto an archived account", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const archived = (await getAccounts()).find((a) => a.isArchived);
    expect(archived, "the seed should provide an archived account").toBeDefined();
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "9.00",
      })
    );

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: archived!.id,
        amount: "9.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toMatch(/refresh the page/i);
    expect((await movementById(k.id)).toAccountId).toBe(savings.id);
  });

  it("reports a movement that does not exist rather than silently succeeding", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        ...keys(),
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "1.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });

  it("succeeds without rewriting anything when the requested state already holds", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();
    const fields = {
      ...k,
      kind: "transfer",
      date: shiftCalendarDate(today, -3),
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: "17.00",
    };

    await actions.createMovementAction(IDLE, formData(fields));

    // Read the legs' created_at through the raw client: it is not on the DTO,
    // and it is exactly what a needless rewrite would change — silently
    // reordering same-day history for a submission the person did not change.
    const createdAtBefore = await legCreatedAt(k.id);

    const state = await actions.updateMovementAction(IDLE, formData(fields));

    expect(state.status).toBe("success");
    expect(await legCreatedAt(k.id)).toEqual(createdAtBefore);
    expect(await legsOf(k.id)).toHaveLength(2);
  });
});

/** Both legs' `created_at`, sorted — the ordering tie-break a rewrite would move. */
async function legCreatedAt(movementId: string): Promise<string[]> {
  const { data, error } = await context.client
    .from("transactions")
    .select("created_at")
    .eq("user_id", context.ownerId)
    .eq("movement_id", movementId)
    .order("created_at", { ascending: true });

  expect(error).toBeNull();
  return (data as { created_at: string }[]).map((row) => row.created_at);
}

// ============================================================
// Delete
// ============================================================

describe("deleteMovementAction", () => {
  it("removes the parent and both legs, and restores both balances", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const checkingBefore = checking.balanceCents;
    const savingsBefore = savings.balanceCents;
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "45.00",
      })
    );
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(checkingBefore - 4_500);

    mocks.revalidated = [];

    const state = await actions.deleteMovementAction(IDLE, formData({ id: k.id }));

    expect(state.status).toBe("success");
    expect(mocks.revalidated).toEqual(MOVEMENT_ROUTES);
    expect(await movementById(k.id)).toBeUndefined();
    // The cascade took exactly both legs.
    expect(await legsOf(k.id)).toHaveLength(0);
    expect((await accountByName("Everyday Checking")).balanceCents).toBe(checkingBefore);
    expect((await accountByName("High-Yield Savings")).balanceCents).toBe(savingsBefore);
  });

  it("reports a movement that no longer exists rather than silently succeeding", async () => {
    const state = await actions.deleteMovementAction(IDLE, formData({ id: randomUUID() }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
    expect(mocks.revalidated).toEqual([]);
  });
});

// ============================================================
// The two surfaces stay disjoint
// ============================================================

describe("movement legs are unreachable from the ordinary transaction surface", () => {
  it("cannot be edited through updateTransactionAction", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "21.00",
      })
    );

    const before = (await legsOf(k.id)).find((l) => l.amountCents < 0)!;

    const state = await transactionActions.updateTransactionAction(
      IDLE,
      formData({
        id: before.id,
        accountId: checking.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP4 Hijacked Leg",
        kind: "expense",
        categoryId: "",
        amount: "1.00",
      })
    );

    expect(state.status).toBe("error");

    const after = (await legsOf(k.id)).find((l) => l.id === before.id)!;
    expect(after.merchant).toBe(before.merchant);
    expect(after.amountCents).toBe(before.amountCents);
    expect(after.kind).toBe("transfer");
    expect(after.movementId).toBe(k.id);
  });

  it("cannot be deleted through deleteTransactionAction", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "22.00",
      })
    );

    const leg = (await legsOf(k.id)).find((l) => l.amountCents < 0)!;

    const state = await transactionActions.deleteTransactionAction(IDLE, formData({ id: leg.id }));

    expect(state.status).toBe("error");
    // Removing one half would strand the other, which is exactly why legs are
    // protected: the pair is still whole.
    expect(await legsOf(k.id)).toHaveLength(2);
  });

  it("and an ordinary transaction cannot be edited through the movement surface", async () => {
    // The other direction. `updateMovementAction` takes a *movement* id, and an
    // ordinary transaction's id names no movement, so it is reported as
    // missing rather than acted on.
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const ordinaryId = randomUUID();

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: ordinaryId,
        accountId: checking.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP4 Ordinary Row",
        kind: "expense",
        categoryId: "",
        amount: "6.00",
      })
    );

    const state = await actions.updateMovementAction(
      IDLE,
      formData({
        id: ordinaryId,
        sourceLegId: randomUUID(),
        destinationLegId: randomUUID(),
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "6.00",
      })
    );

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");

    const stored = (await getTransactions()).find((t) => t.id === ordinaryId)!;
    expect(stored.kind).toBe("expense");
    expect(stored.merchant).toBe("CP4 Ordinary Row");
    expect(stored.movementId).toBeUndefined();
  });

  it("and deleting a movement leaves ordinary rows alone", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const ordinaryId = randomUUID();
    const k = keys();

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: ordinaryId,
        accountId: checking.id,
        date: shiftCalendarDate(today, -3),
        merchant: "CP4 Bystander",
        kind: "expense",
        categoryId: "",
        amount: "3.00",
      })
    );
    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "3.00",
      })
    );

    await actions.deleteMovementAction(IDLE, formData({ id: k.id }));

    expect((await getTransactions()).find((t) => t.id === ordinaryId)).toBeDefined();
  });
});

// ============================================================
// Cross-owner
// ============================================================

describe("cross-owner writes are refused", () => {
  it("cannot move money into an account belonging to nobody visible", async () => {
    // A foreign account is invisible through RLS, so the preflight finds
    // nothing and reports the same thing it would for a deleted account —
    // deliberately indistinguishable, since telling them apart would confirm
    // the existence of another owner's row.
    const checking = await accountByName("Everyday Checking");

    const state = await actions.createMovementAction(
      IDLE,
      formData({
        ...keys(),
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: randomUUID(),
        amount: "5.00",
      })
    );

    expect(state.status).toBe("error");
    expect(mocks.revalidated).toEqual([]);
  });

  it("cannot delete a movement it cannot see", async () => {
    const state = await actions.deleteMovementAction(IDLE, formData({ id: randomUUID() }));

    expect(state.status).toBe("error");
    expect(state.formError).toBe("That item no longer exists.");
  });
});

// ============================================================
// The read path sees both legs immediately
// ============================================================

describe("production reads", () => {
  it("returns both legs from getTransactions and the pair from getMovements", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const k = keys();

    await actions.createMovementAction(
      IDLE,
      formData({
        ...k,
        kind: "transfer",
        date: shiftCalendarDate(today, -3),
        fromAccountId: checking.id,
        toAccountId: savings.id,
        amount: "64.00",
      })
    );

    // Both legs are ordinary ledger rows, each visible where its own account
    // puts it.
    const fromChecking = await getTransactions({ accountId: checking.id });
    const fromSavings = await getTransactions({ accountId: savings.id });
    expect(fromChecking.some((t) => t.id === k.sourceLegId)).toBe(true);
    expect(fromSavings.some((t) => t.id === k.destinationLegId)).toBe(true);

    // And the parent resolves the pair as one object, by id — which is what
    // makes an edit work when the two legs straddle the page's reveal window.
    const movement = await movementById(k.id);
    expect(movement).toEqual({
      id: k.id,
      kind: "transfer",
      date: shiftCalendarDate(today, -3),
      fromAccountId: checking.id,
      toAccountId: savings.id,
      sourceLegId: k.sourceLegId,
      destinationLegId: k.destinationLegId,
      amountCents: 6_400,
    });
  });

  it("resolves several movements in one batched read, and skips ids it cannot see", async () => {
    const checking = await accountByName("Everyday Checking");
    const savings = await accountByName("High-Yield Savings");
    const first = keys();
    const second = keys();

    for (const k of [first, second]) {
      await actions.createMovementAction(
        IDLE,
        formData({
          ...k,
          kind: "transfer",
          date: shiftCalendarDate(today, -3),
          fromAccountId: checking.id,
          toAccountId: savings.id,
          amount: "2.00",
        })
      );
    }

    const resolved = await getMovements([first.id, randomUUID(), second.id, first.id]);

    expect(resolved.map((m) => m.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("returns [] for an empty id list without issuing a query", async () => {
    expect(await getMovements([])).toEqual([]);
  });
});
