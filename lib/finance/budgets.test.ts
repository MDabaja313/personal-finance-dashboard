import { describe, expect, it } from "vitest";
import { toCents, type Budget, type Transaction } from "@/lib/types";
import { budgetStatus } from "@/lib/finance/budgets";

function budget(overrides: Partial<Budget>): Budget {
  return {
    id: "bud-1",
    categoryId: "cat-dining",
    period: "2026-08",
    limitCents: toCents(25_000),
    ...overrides,
  };
}

function expense(amount: number, categoryId = "cat-dining"): Transaction {
  return {
    id: `t-${Math.random()}`,
    accountId: "acc-checking",
    date: "2026-08-10",
    merchant: "Test",
    kind: "expense",
    categoryId,
    amountCents: toCents(-amount),
  };
}

describe("budgetStatus", () => {
  it("is over budget when spend exceeds the limit", () => {
    const status = budgetStatus(budget({ limitCents: toCents(25_000) }), [expense(30_000)]);
    expect(status.spentCents).toBe(30_000);
    expect(status.remainingCents).toBe(-5_000);
    expect(status.utilization).toBe(120);
    expect(status.isOverBudget).toBe(true);
  });

  it("is exactly at the limit", () => {
    const status = budgetStatus(budget({ limitCents: toCents(25_000) }), [expense(25_000)]);
    expect(status.utilization).toBe(100);
    expect(status.isOverBudget).toBe(false);
    expect(status.remainingCents).toBe(0);
  });

  it("is under budget", () => {
    const status = budgetStatus(budget({ limitCents: toCents(25_000) }), [expense(10_000)]);
    expect(status.utilization).toBe(40);
    expect(status.isOverBudget).toBe(false);
    expect(status.remainingCents).toBe(15_000);
  });

  it("has null utilization for a zero limit", () => {
    const status = budgetStatus(budget({ limitCents: toCents(0) }), [expense(5_000)]);
    expect(status.utilization).toBeNull();
    expect(status.isOverBudget).toBe(true);
  });

  it("handles no matching transactions", () => {
    const status = budgetStatus(budget({ categoryId: "cat-dining" }), [expense(5_000, "cat-groceries")]);
    expect(status.spentCents).toBe(0);
    expect(status.utilization).toBe(0);
    expect(status.isOverBudget).toBe(false);
  });
});
