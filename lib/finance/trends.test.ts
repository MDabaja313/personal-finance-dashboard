import { describe, expect, it } from "vitest";
import { toCents, type Transaction } from "@/lib/types";
import { monthlyTotals } from "@/lib/finance/trends";

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
