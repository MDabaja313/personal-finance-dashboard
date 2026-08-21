import { describe, expect, it } from "vitest";
import { toCents, type Account } from "@/lib/types";
import { accountKind, availableCredit, netWorth, totalAssets, totalLiabilities } from "@/lib/finance/accounts";

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

describe("accountKind", () => {
  it("classifies credit and loan as liabilities", () => {
    expect(accountKind("credit")).toBe("liability");
    expect(accountKind("loan")).toBe("liability");
  });

  it("classifies checking/savings/cash/investment as assets", () => {
    expect(accountKind("checking")).toBe("asset");
    expect(accountKind("savings")).toBe("asset");
    expect(accountKind("cash")).toBe("asset");
    expect(accountKind("investment")).toBe("asset");
  });
});

describe("totalAssets / totalLiabilities / netWorth", () => {
  const accounts: Account[] = [
    account({ id: "a1", type: "checking", balanceCents: toCents(100_000) }),
    account({ id: "a2", type: "savings", balanceCents: toCents(500_000) }),
    account({ id: "a3", type: "credit", balanceCents: toCents(-50_000) }),
    account({ id: "a4", type: "loan", balanceCents: toCents(-200_000) }),
    account({ id: "a5", type: "checking", balanceCents: toCents(999_999), isArchived: true }),
  ];

  it("totalAssets sums only active asset accounts", () => {
    expect(totalAssets(accounts)).toBe(600_000);
  });

  it("totalLiabilities returns the positive magnitude of active liability balances", () => {
    expect(totalLiabilities(accounts)).toBe(250_000);
  });

  it("netWorth is the sum of signed active balances", () => {
    expect(netWorth(accounts)).toBe(350_000);
  });

  it("netWorth === totalAssets - totalLiabilities", () => {
    expect(netWorth(accounts)).toBe(totalAssets(accounts) - totalLiabilities(accounts));
  });

  it("handles an empty account list", () => {
    expect(totalAssets([])).toBe(0);
    expect(totalLiabilities([])).toBe(0);
    expect(netWorth([])).toBe(0);
  });

  it("handles a liability-only portfolio", () => {
    const liabilityOnly = [account({ type: "credit", balanceCents: toCents(-30_000) })];
    expect(totalAssets(liabilityOnly)).toBe(0);
    expect(totalLiabilities(liabilityOnly)).toBe(30_000);
    expect(netWorth(liabilityOnly)).toBe(-30_000);
  });
});

describe("availableCredit", () => {
  it("is creditLimit + balance (balance is negative debt)", () => {
    const card = account({
      type: "credit",
      balanceCents: toCents(-128_450),
      creditLimitCents: toCents(500_000),
    });
    expect(availableCredit(card)).toBe(371_550);
  });

  it("is null when there is no credit limit", () => {
    expect(availableCredit(account({ type: "checking" }))).toBeNull();
  });

  it("is 0 on a maxed-out card", () => {
    const maxed = account({
      type: "credit",
      balanceCents: toCents(-500_000),
      creditLimitCents: toCents(500_000),
    });
    expect(availableCredit(maxed)).toBe(0);
  });
});
