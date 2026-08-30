import { describe, expect, it } from "vitest";
import { toCents, type Account, type NetWorthSnapshot, type Transaction } from "@/lib/types";
import { monthlyTotals, snapshotHealth } from "@/lib/finance/trends";

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: "t1",
    accountId: "acc-checking",
    date: "2026-08-01",
    merchant: "Test",
    kind: "income",
    amountCents: toCents(1000),
    ...overrides,
  };
}

function account(overrides: Partial<Account>): Account {
  return {
    id: "acc-1",
    name: "Test Account",
    institution: "Test Bank",
    type: "checking",
    balanceCents: toCents(0),
    isArchived: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<NetWorthSnapshot>): NetWorthSnapshot {
  return {
    month: "2026-08",
    assetsCents: toCents(0),
    liabilitiesCents: toCents(0),
    netWorthCents: toCents(0),
    ...overrides,
  };
}

describe("monthlyTotals", () => {
  it("represents a month with no transactions as zero, not missing", () => {
    const transactions: Transaction[] = [txn({ date: "2026-08-01", amountCents: toCents(100_000) })];
    const result = monthlyTotals(transactions, ["2026-07", "2026-08"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      month: "2026-07",
      incomeCents: 0,
      spendingCents: 0,
      cashFlowCents: 0,
      savingsRate: null,
    });
    expect(result[1].incomeCents).toBe(100_000);
  });

  it("preserves the requested month order", () => {
    const result = monthlyTotals([], ["2026-06", "2026-07", "2026-08"]);
    expect(result.map((r) => r.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("snapshotHealth", () => {
  const accounts: Account[] = [
    account({ id: "a1", type: "checking", balanceCents: toCents(600_000) }),
    account({ id: "a2", type: "credit", balanceCents: toCents(-250_000) }),
  ];
  // live: assets 600_000, liabilities 250_000, netWorth 350_000

  it("is healthy when the current-month snapshot exactly matches live totals", () => {
    const history = [snapshot({ month: "2026-08", assetsCents: toCents(600_000), liabilitiesCents: toCents(250_000), netWorthCents: toCents(350_000) })];
    const result = snapshotHealth(accounts, history, "2026-08");

    expect(result.status).toBe("healthy");
    expect(result.liveAssetsCents).toBe(600_000);
    expect(result.liveLiabilitiesCents).toBe(250_000);
    expect(result.liveNetWorthCents).toBe(350_000);
  });

  it("is stale when there is no current-month snapshot at all", () => {
    const history = [snapshot({ month: "2026-07", assetsCents: toCents(600_000), liabilitiesCents: toCents(250_000), netWorthCents: toCents(350_000) })];
    const result = snapshotHealth(accounts, history, "2026-08");
    expect(result.status).toBe("stale");
  });

  it("is stale when an empty history is passed", () => {
    expect(snapshotHealth(accounts, [], "2026-08").status).toBe("stale");
  });

  it("is stale when the current-month snapshot disagrees with live totals", () => {
    const history = [snapshot({ month: "2026-08", assetsCents: toCents(600_000), liabilitiesCents: toCents(250_000), netWorthCents: toCents(300_000) })];
    expect(snapshotHealth(accounts, history, "2026-08").status).toBe("stale");
  });

  it("is stale on an assets mismatch even when net worth happens to match", () => {
    const history = [snapshot({ month: "2026-08", assetsCents: toCents(700_000), liabilitiesCents: toCents(350_000), netWorthCents: toCents(350_000) })];
    expect(snapshotHealth(accounts, history, "2026-08").status).toBe("stale");
  });

  it("ignores historical months entirely — a mismatched prior month does not make the current month stale", () => {
    const history = [
      snapshot({ month: "2026-07", assetsCents: toCents(1), liabilitiesCents: toCents(1), netWorthCents: toCents(1) }),
      snapshot({ month: "2026-08", assetsCents: toCents(600_000), liabilitiesCents: toCents(250_000), netWorthCents: toCents(350_000) }),
    ];
    expect(snapshotHealth(accounts, history, "2026-08").status).toBe("healthy");
  });

  it("live totals are always the authoritative displayed values, healthy or stale", () => {
    const staleHistory = [snapshot({ month: "2026-08", assetsCents: toCents(1), liabilitiesCents: toCents(1), netWorthCents: toCents(0) })];
    const result = snapshotHealth(accounts, staleHistory, "2026-08");
    expect(result.status).toBe("stale");
    expect(result.liveAssetsCents).toBe(600_000);
    expect(result.liveLiabilitiesCents).toBe(250_000);
    expect(result.liveNetWorthCents).toBe(350_000);
  });
});
