import { describe, expect, it } from "vitest";
import { toCents, type Transaction } from "@/lib/types";
import {
  countsAsIncome,
  countsAsSpending,
  monthlyCashFlow,
  monthlyIncome,
  monthlySpending,
  savingsRate,
  spendingByCategory,
} from "@/lib/finance/transactions";

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: "t1",
    accountId: "acc-checking",
    date: "2026-08-01",
    merchant: "Test",
    kind: "expense",
    amountCents: toCents(-1000),
    ...overrides,
  };
}

describe("countsAsSpending / countsAsIncome — the kind+sign invariant", () => {
  it("expense and refund count as spending; income, transfer and credit_card_payment do not", () => {
    expect(countsAsSpending(txn({ kind: "expense" }))).toBe(true);
    expect(countsAsSpending(txn({ kind: "refund" }))).toBe(true);
    expect(countsAsSpending(txn({ kind: "income" }))).toBe(false);
    expect(countsAsSpending(txn({ kind: "transfer" }))).toBe(false);
    expect(countsAsSpending(txn({ kind: "credit_card_payment" }))).toBe(false);
  });

  it("only income counts as income — a refund is explicitly not income", () => {
    expect(countsAsIncome(txn({ kind: "income" }))).toBe(true);
    expect(countsAsIncome(txn({ kind: "refund" }))).toBe(false);
    expect(countsAsIncome(txn({ kind: "expense" }))).toBe(false);
    expect(countsAsIncome(txn({ kind: "transfer" }))).toBe(false);
    expect(countsAsIncome(txn({ kind: "credit_card_payment" }))).toBe(false);
  });
});

describe("monthlyIncome / monthlySpending — movement exclusion", () => {
  const month = "2026-08";
  const transactions: Transaction[] = [
    txn({ id: "salary", date: "2026-08-01", kind: "income", amountCents: toCents(300_000) }),
    txn({ id: "rent", date: "2026-08-02", kind: "expense", categoryId: "cat-housing", amountCents: toCents(-150_000) }),
    txn({ id: "groceries", date: "2026-08-03", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-20_000) }),
    // A transfer pair — must be invisible to both income and spending.
    txn({ id: "xfer-out", date: "2026-08-04", kind: "transfer", movementId: "mov-1", amountCents: toCents(-50_000) }),
    txn({ id: "xfer-in", date: "2026-08-04", accountId: "acc-savings", kind: "transfer", movementId: "mov-1", amountCents: toCents(50_000) }),
    // A credit-card-payment pair — same requirement.
    txn({ id: "ccpay-out", date: "2026-08-05", kind: "credit_card_payment", movementId: "mov-2", amountCents: toCents(-40_000) }),
    txn({ id: "ccpay-in", date: "2026-08-05", accountId: "acc-credit", kind: "credit_card_payment", movementId: "mov-2", amountCents: toCents(40_000) }),
  ];

  it("income excludes transfers and credit-card payments", () => {
    expect(monthlyIncome(transactions, month)).toBe(300_000);
  });

  it("spending excludes transfers and credit-card payments, and is a positive magnitude", () => {
    expect(monthlySpending(transactions, month)).toBe(170_000);
  });

  it("cash flow is income minus the positive spending magnitude", () => {
    expect(monthlyCashFlow(transactions, month)).toBe(130_000);
  });

  it("savings rate is cash flow as a percentage of income", () => {
    // 130,000 / 300,000 = 43.33%
    expect(savingsRate(transactions, month)).toBe(43.33);
  });

  it("savings rate is null when income is 0", () => {
    expect(savingsRate([txn({ kind: "expense", amountCents: toCents(-1000) })], month)).toBeNull();
  });
});

describe("refunds", () => {
  const month = "2026-08";

  it("a refund reduces category and monthly spending", () => {
    const transactions: Transaction[] = [
      txn({ id: "e1", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-10_000) }),
      txn({ id: "r1", kind: "refund", categoryId: "cat-shopping", amountCents: toCents(3_000) }),
    ];
    expect(monthlySpending(transactions, month)).toBe(7_000);
    expect(spendingByCategory(transactions, month)).toEqual([{ categoryId: "cat-shopping", amountCents: 7_000 }]);
  });

  it("a refund exceeding the same-category spend produces a negative (net-refunded) value", () => {
    const transactions: Transaction[] = [
      txn({ id: "e1", kind: "expense", categoryId: "cat-shopping", amountCents: toCents(-3_000) }),
      txn({ id: "r1", kind: "refund", categoryId: "cat-shopping", amountCents: toCents(9_000) }),
    ];
    expect(monthlySpending(transactions, month)).toBe(-6_000);
    expect(spendingByCategory(transactions, month)).toEqual([{ categoryId: "cat-shopping", amountCents: -6_000 }]);
  });
});

describe("spendingByCategory", () => {
  const month = "2026-08";

  it("skips uncategorized rows but they still count toward total monthly spending", () => {
    const transactions: Transaction[] = [
      txn({ id: "e1", kind: "expense", categoryId: "cat-groceries", amountCents: toCents(-5_000) }),
      txn({ id: "e2", kind: "expense", amountCents: toCents(0) }), // uncategorized, zero-amount
    ];
    expect(spendingByCategory(transactions, month)).toEqual([{ categoryId: "cat-groceries", amountCents: 5_000 }]);
    expect(monthlySpending(transactions, month)).toBe(5_000);
  });

  it("excludes movement legs even if they somehow carried a categoryId", () => {
    const transactions: Transaction[] = [
      txn({ id: "x1", kind: "transfer", movementId: "mov-1", categoryId: "cat-shopping", amountCents: toCents(-1_000) }),
    ];
    expect(spendingByCategory(transactions, month)).toEqual([]);
  });
});
