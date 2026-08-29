import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createMutationContext } from "./support/context";
import { IDLE, formData, shiftCalendarDate } from "./support/mutation-harness";

/**
 * The current-month net-worth snapshot, refreshed after balance-affecting
 * writes — end to end, against real local Supabase.
 *
 * ## Why this file exists separately from the others
 *
 * The snapshot refresh is the one thing in this application that is
 * deliberately *not* transactional with the write that triggers it. PostgREST
 * issues one statement per request, each in its own transaction, so
 * `public.refresh_current_net_worth_snapshot()` is a second request that can
 * fail on its own — and when it does, the ledger write it followed has already
 * committed. Every assertion here is about that seam:
 *
 *   * which writes refresh, and which deliberately do not;
 *   * that the refreshed row matches authoritative live state exactly;
 *   * that a *failed* refresh leaves the primary write committed and the action
 *     reporting success;
 *   * that the failure log carries a classification and nothing else.
 *
 * ## The one extra fake, and why it is safe
 *
 * Two tests replace the injected Supabase client with a thin proxy: one that
 * counts `.rpc()` calls, and one that makes the snapshot RPC — and only that
 * one — return an error. Everything else still goes to the real database
 * through the real client, so "the ledger row survived" is a claim about a real
 * committed row, which is the entire point. Neither proxy touches
 * authentication, RLS, or any other statement.
 *
 * ## Why the snapshot can be compared to live balances at all
 *
 * The Phase 4 writer computes each account's balance as of the target month's
 * **last calendar day**, while `getAccounts()` reports it as of now. Those
 * agree here, and not by luck: `assert_transaction_refs()` refuses any row
 * dated later than the owner's own calendar day, so no transaction can exist
 * between today and month-end. That is what lets these tests assert the
 * snapshot equals `totalAssets`/`totalLiabilities`/`netWorth` exactly rather
 * than approximately.
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

const accountActions = await import("@/lib/actions/accounts");
const categoryActions = await import("@/lib/actions/categories");
const movementActions = await import("@/lib/actions/movements");
const reconciliationActions = await import("@/lib/actions/reconciliation");
const transactionActions = await import("@/lib/actions/transactions");
const { getAccounts } = await import("@/lib/data/accounts");
const { getCategories } = await import("@/lib/data/categories");
const { getToday } = await import("@/lib/data/clock");
const { getNetWorthHistory } = await import("@/lib/data/net-worth");
const { getTransactions } = await import("@/lib/data/transactions");
const { netWorth, totalAssets, totalLiabilities } = await import("@/lib/finance/accounts");
const { monthKey } = await import("@/lib/finance/dates");

let context: Awaited<ReturnType<typeof createMutationContext>>;
let today: string;
/** The owner's own current month — the only month CP5 ever writes. */
let currentMonth: string;

/**
 * A credit account carrying a large, permanent debt.
 *
 * Not decoration, and worth explaining because it looks like it. Phase 4's
 * `private.write_net_worth_snapshot` **raises** rather than storing either
 * magnitude negative, and one of its two guards — `v_liabilities_cents < 0` —
 * fires when the owner's *aggregate* liability balance goes positive, which
 * happens in a perfectly ordinary way: overpay a credit card (CP4 makes that
 * reachable) while every other liability sits at zero (CP5's reconciliation
 * makes *that* reachable). The suite's other files can leave exactly that state
 * behind, and Vitest does not guarantee the order test files run in — so
 * without a floor, whether this file's assertions run against a writer that
 * raises would depend on which file happened to go first.
 *
 * This fixture removes that coupling: one account that is always deeply in
 * debt, so the owner's liabilities are unambiguously positive for the whole
 * file whatever else has happened.
 *
 * It is a fixture, not a workaround for something untested. Both guards — the
 * asset one as well as the liability one — are characterized directly in
 * "the writer's sign guards are reachable, and degrade to a stale trend" at the
 * bottom of this file, and at the database layer in
 * `supabase/tests/database/160-current-snapshot.sql`. CP5 does not change the
 * Phase 4 writer; the best-effort refresh is what makes either guard degrade to
 * a stale trend rather than a failed ledger write.
 */
const LIABILITY_FLOOR_NAME = "Snapshot Liability Floor";

beforeAll(async () => {
  context = await createMutationContext();
  mocks.client = context.client;
  mocks.ownerId = context.ownerId;
  today = await getToday();
  currentMonth = monthKey(today);

  const created = await accountActions.createAccountAction(
    IDLE,
    formData({
      name: LIABILITY_FLOOR_NAME,
      institution: "Probe Bank",
      type: "credit",
      openingBalance: "-50000.00",
      creditLimit: "100000.00",
      interestRate: "",
    })
  );
  expect(created.status).toBe("success");
}, 30_000);

beforeEach(() => {
  mocks.revalidated = [];
  mocks.redirectedTo = null;
  // Every test starts from the unmodified real client; the two that swap it in
  // put it back in `afterEach`.
  mocks.client = context.client;
});

afterEach(() => {
  mocks.client = context.client;
  vi.restoreAllMocks();
});

// ============================================================
// Helpers
// ============================================================

async function accountByName(name: string) {
  const account = (await getAccounts()).find((a) => a.name === name);
  expect(account, `the seed should provide the '${name}' account`).toBeDefined();
  return account!;
}

/** The current month's snapshot, read through the production read DAL. */
async function currentSnapshot() {
  return (await getNetWorthHistory()).find((s) => s.month === currentMonth);
}

/** What the current month's snapshot *should* say, from live account state. */
async function authoritativeTotals() {
  const accounts = await getAccounts();
  return {
    assetsCents: totalAssets(accounts),
    liabilitiesCents: totalLiabilities(accounts),
    netWorthCents: netWorth(accounts),
  };
}

async function expectSnapshotMatchesLiveState() {
  const snapshot = await currentSnapshot();
  expect(snapshot, `a snapshot should exist for ${currentMonth}`).toBeDefined();

  const expected = await authoritativeTotals();
  expect(snapshot!.assetsCents).toBe(expected.assetsCents);
  expect(snapshot!.liabilitiesCents).toBe(expected.liabilitiesCents);
  expect(snapshot!.netWorthCents).toBe(expected.netWorthCents);
  // The DTO commits to the convention explicitly rather than implying it.
  expect(snapshot!.netWorthCents).toBe(snapshot!.assetsCents - snapshot!.liabilitiesCents);
}

/**
 * A client that behaves exactly like the real one but records every `.rpc()`
 * name it is asked for.
 *
 * `Reflect.get(target, prop, target)` plus an explicit bind, rather than
 * forwarding the proxy as the receiver: supabase-js methods are class methods
 * that read private state off `this`, and handing them the proxy would make
 * every internal property access route back through this trap.
 */
function recordingClient(real: object, calls: string[]): object {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "rpc") {
        return (name: string, args?: unknown) => {
          calls.push(name);
          return (target as { rpc: (n: string, a?: unknown) => unknown }).rpc(name, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The driver payload a failing refresh would carry. Nothing in it may be logged. */
const SNAPSHOT_FAILURE = Object.freeze({
  code: "57P01",
  message: "terminating connection due to administrator command",
  details: "Failing row contains (…, -1234567, Secret Merchant Ltd, …)",
  hint: "net_worth_snapshots_pkey",
});

/** A client whose snapshot RPC always fails; every other statement is real. */
function failingSnapshotClient(real: object): object {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "rpc") {
        return (name: string, args?: unknown) => {
          if (name === "refresh_current_net_worth_snapshot") {
            return Promise.resolve({ data: null, error: { ...SNAPSHOT_FAILURE } });
          }
          return (target as { rpc: (n: string, a?: unknown) => unknown }).rpc(name, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ============================================================
// Which writes refresh
// ============================================================

describe("balance-affecting writes refresh the current month's snapshot", () => {
  it("an ordinary transaction does", async () => {
    const account = await accountByName("Everyday Checking");
    const category = (await getCategories()).find((c) => c.kind === "expense" && !c.isArchived)!;

    const state = await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Snapshot probe",
        kind: "expense",
        categoryId: category.id,
        amount: "42.00",
      })
    );

    expect(state.status).toBe("success");
    // The row really landed — otherwise "the snapshot matches" would be
    // trivially true.
    expect((await getAccounts()).find((a) => a.id === account.id)!.balanceCents).toBe(
      account.balanceCents - 4_200
    );
    await expectSnapshotMatchesLiveState();
  });

  it("editing and deleting an ordinary transaction do", async () => {
    const account = await accountByName("Everyday Checking");
    const id = randomUUID();

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: today,
        merchant: "Snapshot probe edit",
        kind: "expense",
        categoryId: "",
        amount: "10.00",
      })
    );

    const edited = await transactionActions.updateTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: today,
        merchant: "Snapshot probe edit",
        kind: "expense",
        categoryId: "",
        amount: "90.00",
      })
    );
    expect(edited.status).toBe("success");
    await expectSnapshotMatchesLiveState();

    const deleted = await transactionActions.deleteTransactionAction(IDLE, formData({ id }));
    expect(deleted.status).toBe("success");
    await expectSnapshotMatchesLiveState();
  });

  it("creating an account does, and so does changing its opening balance", async () => {
    // A fresh account, because CP2's `accounts_guard_update()` only permits an
    // opening-balance edit while the account has zero transactions — which is
    // exactly the case where that figure is the whole balance.
    const name = `Snapshot Probe ${randomUUID().slice(0, 8)}`;

    const created = await accountActions.createAccountAction(
      IDLE,
      formData({
        name,
        institution: "Probe Bank",
        type: "savings",
        openingBalance: "1000.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    expect(created.status).toBe("success");
    await expectSnapshotMatchesLiveState();

    const account = await accountByName(name);
    expect(account.balanceCents).toBe(100_000);

    const edited = await accountActions.updateAccountAction(
      IDLE,
      formData({
        id: account.id,
        name,
        institution: "Probe Bank",
        openingBalance: "2500.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    expect(edited.status).toBe("success");
    expect((await accountByName(name)).balanceCents).toBe(250_000);
    await expectSnapshotMatchesLiveState();
  });

  it("archiving and unarchiving an account do — the writer excludes archived accounts", async () => {
    const name = `Snapshot Archive ${randomUUID().slice(0, 8)}`;
    await accountActions.createAccountAction(
      IDLE,
      formData({
        name,
        institution: "Probe Bank",
        type: "checking",
        openingBalance: "0.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    const account = await accountByName(name);

    const archived = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "true" })
    );
    expect(archived.status).toBe("success");
    await expectSnapshotMatchesLiveState();

    const restored = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "false" })
    );
    expect(restored.status).toBe("success");
    await expectSnapshotMatchesLiveState();
  });

  it("a credit-card payment does — assets and liabilities move together", async () => {
    // The case that most needs covering: a card payment leaves net worth
    // unchanged while moving an asset down and a liability toward zero, so a
    // snapshot that tracked only `net_worth_cents` would look correct and have
    // the wrong composition.
    const from = await accountByName("Everyday Checking");
    // A card created here rather than the seeded one, so the amount paid is
    // guaranteed to be smaller than what is owed. Paying more than a card owes
    // is legal (an overpaid card is a real thing), but it would make this
    // assertion depend on how much of the seeded card's balance other test
    // files had already paid off.
    const cardName = `Snapshot Card ${randomUUID().slice(0, 8)}`;
    const createdCard = await accountActions.createAccountAction(
      IDLE,
      formData({
        name: cardName,
        institution: "Probe Bank",
        type: "credit",
        openingBalance: "-1000.00",
        creditLimit: "5000.00",
        interestRate: "",
      })
    );
    expect(createdCard.status).toBe("success");
    const card = await accountByName(cardName);

    const before = await currentSnapshot();
    expect(before).toBeDefined();

    const state = await movementActions.createMovementAction(
      IDLE,
      formData({
        id: randomUUID(),
        sourceLegId: randomUUID(),
        destinationLegId: randomUUID(),
        kind: "credit_card_payment",
        date: today,
        fromAccountId: from.id,
        toAccountId: card.id,
        amount: "300.00",
      })
    );
    expect(state.status).toBe("success");

    const after = await currentSnapshot();
    expect(after).toBeDefined();
    expect(after!.assetsCents).toBe(before!.assetsCents - 30_000);
    expect(after!.liabilitiesCents).toBe(before!.liabilitiesCents - 30_000);
    expect(after!.netWorthCents).toBe(before!.netWorthCents);
    await expectSnapshotMatchesLiveState();
  });

  it("deleting a movement does", async () => {
    const from = await accountByName("Everyday Checking");
    const to = await accountByName("High-Yield Savings");
    const movementId = randomUUID();

    await movementActions.createMovementAction(
      IDLE,
      formData({
        id: movementId,
        sourceLegId: randomUUID(),
        destinationLegId: randomUUID(),
        kind: "transfer",
        date: shiftCalendarDate(today, -1),
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: "55.00",
      })
    );

    const state = await movementActions.deleteMovementAction(IDLE, formData({ id: movementId }));
    expect(state.status).toBe("success");
    await expectSnapshotMatchesLiveState();
  });

  it("a reconciliation does, and so does removing its adjustment", async () => {
    const account = await accountByName("Brokerage Account");

    const reconciled = await reconciliationActions.reconcileAccountAction(
      IDLE,
      formData({
        accountId: account.id,
        asOf: today,
        balance: `${Math.trunc((account.balanceCents - 66_600) / 100)}.${String(
          Math.abs(account.balanceCents - 66_600) % 100
        ).padStart(2, "0")}`,
      })
    );
    expect(reconciled.status).toBe("success");
    await expectSnapshotMatchesLiveState();

    const adjustment = (await getTransactions({ kind: "adjustment" })).find(
      (t) => t.accountId === account.id && t.amountCents === -66_600
    );
    expect(adjustment).toBeDefined();

    const removed = await reconciliationActions.deleteAdjustmentAction(
      IDLE,
      formData({ id: adjustment!.id })
    );
    expect(removed.status).toBe("success");
    await expectSnapshotMatchesLiveState();
  });
});

// ============================================================
// Which writes deliberately do not refresh
// ============================================================

describe("writes that cannot move a snapshot figure do not refresh it", () => {
  it("a category write does not", async () => {
    // A category is a label. It appears in no snapshot column, so refreshing
    // after one would be a whole-user aggregate recomputation for a change that
    // cannot alter a single number in it.
    const calls: string[] = [];
    mocks.client = recordingClient(context.client as object, calls);

    const state = await categoryActions.createCategoryAction(
      IDLE,
      formData({ name: `Probe ${randomUUID().slice(0, 8)}`, kind: "expense" })
    );

    expect(state.status).toBe("success");
    expect(calls).toEqual([]);
  });

  it("a metadata-only account edit does not", async () => {
    // Renaming an account, or changing its institution, credit limit or
    // interest rate, moves no balance. Only the opening balance can, and that
    // path is asserted to refresh above.
    const name = `Snapshot Meta ${randomUUID().slice(0, 8)}`;
    await accountActions.createAccountAction(
      IDLE,
      formData({
        name,
        institution: "Probe Bank",
        type: "checking",
        openingBalance: "77.00",
        creditLimit: "",
        interestRate: "",
      })
    );
    const account = await accountByName(name);

    const calls: string[] = [];
    mocks.client = recordingClient(context.client as object, calls);

    const state = await accountActions.updateAccountAction(
      IDLE,
      formData({
        id: account.id,
        name: `${name} renamed`,
        institution: "Renamed Bank",
        // Blank means "unchanged" on the edit form, so this submission changes
        // no balance at all.
        openingBalance: "",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(state.status).toBe("success");
    expect(calls).toEqual([]);
  });

  it("a transaction create that deduplicates does not refresh a second time", async () => {
    // The retry wrote nothing, so the snapshot it would recompute is the one
    // the first attempt already produced.
    const account = await accountByName("Everyday Checking");
    const id = randomUUID();
    const form = () =>
      formData({
        id,
        accountId: account.id,
        date: today,
        merchant: "Snapshot dedupe probe",
        kind: "expense",
        categoryId: "",
        amount: "3.00",
      });

    const first = await transactionActions.createTransactionAction(IDLE, form());
    expect(first.status).toBe("success");

    const calls: string[] = [];
    mocks.client = recordingClient(context.client as object, calls);

    const retry = await transactionActions.createTransactionAction(IDLE, form());
    expect(retry.status).toBe("success");
    expect(calls).toEqual([]);
  });

  it("a zero-delta reconciliation does not refresh", async () => {
    const account = await accountByName("High-Yield Savings");

    const calls: string[] = [];
    mocks.client = recordingClient(context.client as object, calls);

    const state = await reconciliationActions.reconcileAccountAction(
      IDLE,
      formData({
        accountId: account.id,
        asOf: today,
        balance: `${Math.trunc(account.balanceCents / 100)}.${String(
          Math.abs(account.balanceCents) % 100
        ).padStart(2, "0")}`,
      })
    );

    expect(state.status).toBe("success");
    // The reconciliation RPC itself was called; the snapshot refresh was not,
    // because no row was written.
    expect(calls).toEqual(["reconcile_account"]);
  });
});

// ============================================================
// A failed refresh is a secondary failure, always
// ============================================================

describe("a failing snapshot refresh never fails the write it followed", () => {
  it("leaves an ordinary transaction committed and reports success", async () => {
    const account = await accountByName("Everyday Checking");
    const balanceBefore = account.balanceCents;
    const id = randomUUID();

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client = failingSnapshotClient(context.client as object);

    const state = await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id,
        accountId: account.id,
        date: today,
        merchant: "Committed despite snapshot failure",
        kind: "expense",
        categoryId: "",
        amount: "17.00",
      })
    );

    // The action reports the primary mutation's outcome, which is what actually
    // happened.
    expect(state.status).toBe("success");
    expect(state.formError).toBeNull();
    // And the route was still revalidated — the write is real and the page must
    // show it.
    expect(mocks.revalidated).toContain("/transactions");

    // Back on the real client: the row is genuinely there, and the balance
    // moved. This is the assertion that makes "secondary" mean something.
    mocks.client = context.client;
    const written = (await getTransactions({ month: currentMonth })).find((t) => t.id === id);
    expect(written).toBeDefined();
    expect(written!.amountCents).toBe(-1_700);
    expect((await getAccounts()).find((a) => a.id === account.id)!.balanceCents).toBe(
      balanceBefore - 1_700
    );

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("leaves a reconciliation committed and reports success", async () => {
    const account = await accountByName("Cash Wallet");
    const target = account.balanceCents - 1_111;

    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client = failingSnapshotClient(context.client as object);

    const state = await reconciliationActions.reconcileAccountAction(
      IDLE,
      formData({
        accountId: account.id,
        asOf: today,
        balance: `${Math.trunc(target / 100)}.${String(Math.abs(target) % 100).padStart(2, "0")}`,
      })
    );

    expect(state.status).toBe("success");

    mocks.client = context.client;
    expect((await getAccounts()).find((a) => a.id === account.id)!.balanceCents).toBe(target);
  });

  it("logs a classification and no financial payload", async () => {
    const account = await accountByName("Everyday Checking");

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client = failingSnapshotClient(context.client as object);

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Secret Merchant Ltd",
        kind: "expense",
        categoryId: "",
        amount: "9876.54",
      })
    );

    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0].map(String).join(" ");

    // What it must say: which operation, and how the failure classified.
    expect(line).toContain("net-worth snapshot refresh failed");
    expect(line).toContain("the transaction");
    expect(line).toContain("[unavailable]");

    // What it must never say. The driver payload above deliberately contains an
    // amount, a merchant, a constraint name and a SQLSTATE, so each of these is
    // a real string that was available to be leaked and was not.
    expect(line).not.toContain("Secret Merchant Ltd");
    expect(line).not.toContain("9876.54");
    expect(line).not.toContain("987654");
    expect(line).not.toContain("1234567");
    expect(line).not.toContain("57P01");
    expect(line).not.toContain("net_worth_snapshots_pkey");
    expect(line).not.toContain(SNAPSHOT_FAILURE.message);
    expect(line).not.toContain(SNAPSHOT_FAILURE.details);
    // Nor the owner's id, which is not financial but is still not log material.
    expect(line).not.toContain(mocks.ownerId);
  });

  it("recovers on the next successful write — the snapshot is not left behind", async () => {
    // The stale window is bounded by the next balance-affecting write, because
    // the writer recomputes the whole month from current state rather than
    // applying a delta. That is what makes swallowing the failure acceptable
    // rather than merely convenient.
    const account = await accountByName("Everyday Checking");

    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client = failingSnapshotClient(context.client as object);
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Stale-making write",
        kind: "expense",
        categoryId: "",
        amount: "5.00",
      })
    );

    mocks.client = context.client;
    const stale = await currentSnapshot();
    const live = await authoritativeTotals();
    expect(stale!.netWorthCents).not.toBe(live.netWorthCents);

    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Recovering write",
        kind: "expense",
        categoryId: "",
        amount: "1.00",
      })
    );

    await expectSnapshotMatchesLiveState();
  });
});

// ============================================================
// The month, and only that month
// ============================================================

describe("the refresh touches exactly one month, chosen by the owner's timezone", () => {
  it("writes the owner's own current month and leaves every prior month alone", async () => {
    const before = await getNetWorthHistory();
    const priorBefore = before.filter((s) => s.month !== currentMonth);
    expect(priorBefore.length).toBeGreaterThan(0);

    const account = await accountByName("Everyday Checking");
    await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Month probe",
        kind: "expense",
        categoryId: "",
        amount: "2.00",
      })
    );

    const after = await getNetWorthHistory();

    // The month written is the one `getToday()` reports, which comes from the
    // owner's `profiles.timezone` — the same source the database derives it
    // from inside the bridge. If the two ever disagreed, this is where it would
    // show, because the row would land under a month key this test cannot find.
    expect(after.some((s) => s.month === currentMonth)).toBe(true);

    // Prior months are untouched, byte for byte. CP5 repairs no history, by
    // design.
    const priorAfter = after.filter((s) => s.month !== currentMonth);
    expect(priorAfter).toEqual(priorBefore);

    // And no month was invented.
    expect(after.filter((s) => s.month > currentMonth)).toEqual([]);
  });
});

// ============================================================
// Phase 4's two sign guards, reached through supported CP5 writes
// ============================================================

describe("the writer's sign guards are reachable, and degrade to a stale trend", () => {
  /**
   * `private.write_net_worth_snapshot` raises rather than storing either
   * magnitude negative:
   *
   *     if v_assets_cents < 0      then raise ... 'data_exception'  -- 22000
   *     if v_liabilities_cents < 0 then raise ... 'data_exception'  -- 22000
   *
   * Both guards are Phase 4's, written when nothing could produce either state
   * and nothing called the writer. CP4 and CP5 made both states reachable
   * through ordinary supported writes, and CP5 made the writer run after every
   * balance-affecting one — so these two tests characterize what actually
   * happens, at the layer a person would experience it.
   *
   * What must hold in both cases, and is asserted in both:
   *
   *   1. the primary write **commits** and the action reports success;
   *   2. exactly one sanitized line is logged, carrying no figures;
   *   3. the snapshot is left **stale**, byte for byte — never wrong;
   *   4. an ordinary supported write brings both back.
   *
   * Each test restores the state it created, so neither leaves the shared
   * database in a shape the rest of the suite has to tolerate.
   *
   * A large opening balance is used rather than a long series of realistic
   * writes because it isolates the guard under test: the point is *which*
   * aggregate goes negative, and a figure that dominates every other account
   * makes that unambiguous whatever the other files have left behind. The
   * realistic routes are ordinary and are noted on each test; the CP4
   * card-overpayment route is exercised for real in
   * `supabase/tests/database/160-current-snapshot.sql`.
   */

  /** The sanitized log line, asserted to carry a classification and no money. */
  function expectSanitizedSnapshotLog(logged: ReturnType<typeof vi.spyOn>) {
    expect(logged).toHaveBeenCalledTimes(1);
    const line = (logged.mock.calls[0] as unknown[]).map(String).join(" ");
    expect(line).toContain("net-worth snapshot refresh failed");
    // SQLSTATE 22000 is class 22, which `mapWriteError` classifies as
    // `invalid_input` — a different label from the transport failure asserted
    // above, and the reason the classification is worth logging at all.
    expect(line).toContain("[invalid_input]");
    // Never the figures that caused it, and never the raise's own text.
    expect(line).not.toContain("999999");
    expect(line).not.toContain("99999900");
    expect(line).not.toContain("22000");
    expect(line).not.toContain("negative asset magnitude");
    expect(line).not.toContain("negative liability magnitude");
    expect(line).not.toContain(mocks.ownerId);
    return line;
  }

  it("aggregate assets below zero: the account commits, the snapshot goes stale", async () => {
    // Reachable four ordinary ways, none of which this application refuses:
    // opening an account at a negative balance (the create form's own hint
    // says the figure is signed), overdrawing one with a CP3 expense,
    // transferring out of one, or reconciling one to a negative observed
    // balance — which CP5's asset form invites explicitly ("Enter a negative
    // amount if the account is overdrawn"). The *aggregate* only goes negative
    // when the owner's whole asset position does, which is an ordinary state
    // for someone with one overdrawn current account and no savings.
    const before = await currentSnapshot();
    expect(before).toBeDefined();

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const name = `Snapshot Overdrawn ${randomUUID().slice(0, 8)}`;
    const created = await accountActions.createAccountAction(
      IDLE,
      formData({
        name,
        institution: "Probe Bank",
        type: "checking",
        openingBalance: "-999999.00",
        creditLimit: "",
        interestRate: "",
      })
    );

    // 1. The primary write is reported as what it is: successful.
    expect(created.status).toBe("success");
    expect(created.formError).toBeNull();

    // …and it really committed.
    const account = await accountByName(name);
    expect(account.balanceCents).toBe(-99_999_900);

    // The state under test is genuinely the one under test.
    const live = await authoritativeTotals();
    expect(live.assetsCents).toBeLessThan(0);

    // 2. One sanitized line.
    expectSanitizedSnapshotLog(logged);

    // 3. Stale, not corrupted — byte for byte what it was.
    expect(await currentSnapshot()).toEqual(before);

    // A second ledger write against the same owner still commits and still
    // reports success, so the failure is not sticky at the application layer.
    const followUp = await transactionActions.createTransactionAction(
      IDLE,
      formData({
        id: randomUUID(),
        accountId: account.id,
        date: today,
        merchant: "Still committing",
        kind: "expense",
        categoryId: "",
        amount: "1.00",
      })
    );
    expect(followUp.status).toBe("success");
    expect((await accountByName(name)).balanceCents).toBe(-100_000_000);

    // 4. Recovery, through supported writes only: reconcile to zero, then
    // archive (which CP2 permits precisely because the balance is now zero).
    const reconciled = await reconciliationActions.reconcileAccountAction(
      IDLE,
      formData({ accountId: account.id, asOf: today, balance: "0" })
    );
    expect(reconciled.status).toBe("success");
    expect((await accountByName(name)).balanceCents).toBe(0);

    const archived = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "true" })
    );
    expect(archived.status).toBe("success");

    await expectSnapshotMatchesLiveState();
  });

  it("aggregate liabilities above zero: the account commits, the snapshot goes stale", async () => {
    // The realistic route is a CP4 credit-card payment larger than the card
    // owes, with no other debt to offset it — proved end to end through
    // `public.create_movement` in 160-current-snapshot.sql. Here the same
    // *state* is reached in one write, so the assertion isolates the liability
    // guard instead of also moving assets by the size of the payment.
    const before = await currentSnapshot();
    expect(before).toBeDefined();

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const name = `Snapshot Overpaid ${randomUUID().slice(0, 8)}`;
    const created = await accountActions.createAccountAction(
      IDLE,
      formData({
        name,
        institution: "Probe Bank",
        type: "credit",
        openingBalance: "999999.00",
        creditLimit: "",
        interestRate: "",
      })
    );

    expect(created.status).toBe("success");
    expect(created.formError).toBeNull();

    const account = await accountByName(name);
    expect(account.balanceCents).toBe(99_999_900);

    const live = await authoritativeTotals();
    // `totalLiabilities` negates the signed sum, so a positive aggregate
    // liability position shows up here as a negative magnitude — the exact
    // figure the writer refuses to store.
    expect(live.liabilitiesCents).toBeLessThan(0);
    // Assets are untouched, so this really is the *other* guard.
    expect(live.assetsCents).toBeGreaterThan(0);

    expectSanitizedSnapshotLog(logged);

    expect(await currentSnapshot()).toEqual(before);

    // Recovery: the card's reconcile form asks for a non-negative amount owed,
    // so "0" is the supported way back — and it works, because reconciliation
    // writes the correcting adjustment before the refresh runs.
    const reconciled = await reconciliationActions.reconcileAccountAction(
      IDLE,
      formData({ accountId: account.id, asOf: today, balance: "0" })
    );
    expect(reconciled.status).toBe("success");
    expect((await accountByName(name)).balanceCents).toBe(0);

    const archived = await accountActions.setAccountArchivedAction(
      IDLE,
      formData({ id: account.id, archived: "true" })
    );
    expect(archived.status).toBe("success");

    await expectSnapshotMatchesLiveState();
  });
});
