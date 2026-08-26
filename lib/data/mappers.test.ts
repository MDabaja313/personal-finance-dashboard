import { describe, expect, it } from "vitest";

import {
  calendarDateFrom,
  centsFrom,
  centsOrUndefined,
  enumFrom,
  integerFrom,
  monthKeyFrom,
  toAccount,
  toBill,
  toBudget,
  toCategory,
  toGoal,
  toNetWorthSnapshot,
  toTransaction,
  ACCOUNT_TYPES,
} from "@/lib/data/mappers";
import type {
  AccountBalanceRow,
  BillRow,
  BudgetRow,
  CategoryRow,
  GoalBalanceRow,
  NetWorthSnapshotRow,
  TransactionRow,
} from "@/lib/data/rows";
import { AppError, isAppError } from "@/lib/errors";

// A value that survives JSON but not the safe-integer invariant, chosen so a
// leak into a user-facing message is unmistakable in an assertion.
const UNSAFE_CENTS = Number.MAX_SAFE_INTEGER + 2; // 9007199254740993

function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw new Error(`Expected an AppError, received: ${String(error)}`);
  }
  throw new Error("Expected the mapper to throw, but it returned normally.");
}

// ============================================================
// Fixture rows — valid by construction; each test perturbs one field.
// ============================================================

const accountRow: AccountBalanceRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Everyday Checking",
  institution: "First National",
  type: "checking",
  is_archived: false,
  balance_cents: 412_35,
  credit_limit_cents: null,
  interest_rate_bps: null,
};

const categoryRow: CategoryRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Groceries",
  kind: "expense",
};

const transactionRow: TransactionRow = {
  id: "33333333-3333-4333-8333-333333333333",
  account_id: accountRow.id,
  date: "2026-08-18",
  merchant: "Whole Foods",
  kind: "expense",
  category_id: categoryRow.id,
  movement_id: null,
  amount_cents: -84_20,
};

const budgetRow: BudgetRow = {
  id: "44444444-4444-4444-8444-444444444444",
  category_id: categoryRow.id,
  period: "2026-08",
  limit_cents: 600_00,
};

const billRow: BillRow = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Electric",
  amount_cents: -120_00,
  frequency: "monthly",
  category_id: categoryRow.id,
  account_id: accountRow.id,
};

const goalRow: GoalBalanceRow = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Emergency Fund",
  target_cents: 10_000_00,
  target_date: "2026-12-31",
  saved_cents: 4_250_00,
};

const snapshotRow: NetWorthSnapshotRow = {
  month: "2026-08",
  assets_cents: 50_000_00,
  liabilities_cents: 12_000_00,
  net_worth_cents: 38_000_00,
};

// ============================================================
// centsFrom / centsOrUndefined
// ============================================================

describe("centsFrom", () => {
  it("brands a safe integer, including zero and negatives", () => {
    expect(centsFrom(0, "t.amount_cents")).toBe(0);
    expect(centsFrom(-84_20, "t.amount_cents")).toBe(-8420);
    expect(centsFrom(Number.MAX_SAFE_INTEGER, "t.amount_cents")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accepts a quoted bigint, in case PostgREST ever serializes one as a string", () => {
    expect(centsFrom("412350", "t.amount_cents")).toBe(412350);
    expect(centsFrom("-1", "t.amount_cents")).toBe(-1);
  });

  it("rejects an unsafe integer as data_integrity rather than truncating it", () => {
    const error = caught(() => centsFrom(UNSAFE_CENTS, "transactions.amount_cents"));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("data_integrity");
    expect(error.message).toContain("transactions.amount_cents");
  });

  it("rejects a quoted value that parses to an unsafe integer, rather than truncating it", () => {
    const error = caught(() => centsFrom("9007199254740993", "transactions.amount_cents"));

    expect(error.code).toBe("data_integrity");
  });

  it("rejects a non-integer", () => {
    expect(caught(() => centsFrom(12.5, "budgets.limit_cents")).code).toBe("data_integrity");
    expect(caught(() => centsFrom("12.5", "budgets.limit_cents")).code).toBe("data_integrity");
  });

  it("rejects non-numeric values", () => {
    for (const value of [null, undefined, {}, [], true, "abc", Number.NaN, Infinity]) {
      expect(caught(() => centsFrom(value, "budgets.limit_cents")).code).toBe("data_integrity");
    }
  });

  it("rejects an empty or whitespace string instead of reading it as zero", () => {
    // Number("") === 0 — an empty column must never become a zero balance.
    expect(caught(() => centsFrom("", "accounts.balance_cents")).code).toBe("data_integrity");
    expect(caught(() => centsFrom("   ", "accounts.balance_cents")).code).toBe("data_integrity");
  });

  it("names the column and never the value in the user-facing message", () => {
    const error = caught(() => centsFrom(UNSAFE_CENTS, "transactions.amount_cents"));

    expect(error.message).toContain("transactions.amount_cents");
    expect(error.message).not.toContain(String(UNSAFE_CENTS));
    expect(error.message).not.toMatch(/\d{4,}/);
  });

  it("preserves the original throw as `cause`, where the value stays server-side", () => {
    const error = caught(() => centsFrom(UNSAFE_CENTS, "transactions.amount_cents"));

    expect(error.cause).toBeInstanceOf(Error);
    // toCents's own message does embed the value — that is exactly why it is
    // confined to `cause` and never re-quoted into the AppError message.
    expect((error.cause as Error).message).toContain(String(UNSAFE_CENTS));
  });
});

describe("centsOrUndefined", () => {
  it("maps null and undefined to undefined, never to zero", () => {
    expect(centsOrUndefined(null, "accounts.credit_limit_cents")).toBeUndefined();
    expect(centsOrUndefined(undefined, "accounts.credit_limit_cents")).toBeUndefined();
  });

  it("still validates a present value", () => {
    expect(centsOrUndefined(500_00, "accounts.credit_limit_cents")).toBe(50000);
    expect(caught(() => centsOrUndefined(UNSAFE_CENTS, "accounts.credit_limit_cents")).code).toBe(
      "data_integrity"
    );
  });
});

// ============================================================
// integerFrom — basis points, deliberately not Cents
// ============================================================

describe("integerFrom", () => {
  it("accepts an integer and returns a plain number", () => {
    expect(integerFrom(1899, "accounts.interest_rate_bps")).toBe(1899);
    expect(integerFrom(0, "accounts.interest_rate_bps")).toBe(0);
  });

  it("rejects a non-integer, an unsafe integer, and a non-number", () => {
    for (const value of [18.99, UNSAFE_CENTS, "1899", null, undefined, Number.NaN]) {
      expect(caught(() => integerFrom(value, "accounts.interest_rate_bps")).code).toBe("data_integrity");
    }
  });

  it("names the column, not the value", () => {
    const error = caught(() => integerFrom(18.99, "accounts.interest_rate_bps"));

    expect(error.message).toContain("accounts.interest_rate_bps");
    expect(error.message).not.toContain("18.99");
  });
});

// ============================================================
// calendarDateFrom / monthKeyFrom / enumFrom
// ============================================================

describe("calendarDateFrom", () => {
  it("accepts a 'YYYY-MM-DD' string", () => {
    expect(calendarDateFrom("2026-08-18", "transactions.date")).toBe("2026-08-18");
  });

  it("rejects anything that would break lexicographic date comparison", () => {
    for (const value of ["2026-08-18T00:00:00Z", "2026-8-18", "08/18/2026", "", 20260818, null]) {
      expect(caught(() => calendarDateFrom(value, "transactions.date")).code).toBe("data_integrity");
    }
  });
});

describe("monthKeyFrom", () => {
  it("accepts a 'YYYY-MM' period", () => {
    expect(monthKeyFrom("2026-08", "budgets.period")).toBe("2026-08");
  });

  it("rejects a malformed or out-of-range month", () => {
    for (const value of ["2026-13", "2026-00", "2026-8", "2026-08-01", null]) {
      expect(caught(() => monthKeyFrom(value, "budgets.period")).code).toBe("data_integrity");
    }
  });
});

describe("enumFrom", () => {
  it("narrows a recognized enum value", () => {
    expect(enumFrom("credit", ACCOUNT_TYPES, "accounts.type")).toBe("credit");
  });

  it("rejects an unrecognized value as data_integrity, without quoting it", () => {
    const error = caught(() => enumFrom("crypto_wallet", ACCOUNT_TYPES, "accounts.type"));

    expect(error.code).toBe("data_integrity");
    expect(error.message).toContain("accounts.type");
    expect(error.message).not.toContain("crypto_wallet");
  });

  it("rejects a non-string", () => {
    expect(caught(() => enumFrom(1, ACCOUNT_TYPES, "accounts.type")).code).toBe("data_integrity");
  });
});

// ============================================================
// Row → DTO
// ============================================================

describe("toAccount", () => {
  it("maps a view row to the Account DTO", () => {
    expect(toAccount({ ...accountRow, balance_cents: -1_234_56, type: "credit" })).toEqual({
      id: accountRow.id,
      name: "Everyday Checking",
      institution: "First National",
      type: "credit",
      balanceCents: -123456,
      creditLimitCents: undefined,
      interestRateBps: undefined,
      isArchived: false,
    });
  });

  it("maps null credit_limit_cents and interest_rate_bps to undefined", () => {
    const account = toAccount(accountRow);

    expect(account.creditLimitCents).toBeUndefined();
    expect(account.interestRateBps).toBeUndefined();
  });

  it("carries a present credit limit and interest rate through", () => {
    const account = toAccount({
      ...accountRow,
      type: "credit",
      credit_limit_cents: 5_000_00,
      interest_rate_bps: 1899,
    });

    expect(account.creditLimitCents).toBe(500000);
    expect(account.interestRateBps).toBe(1899);
  });

  it("rejects an unrecognized account type", () => {
    expect(caught(() => toAccount({ ...accountRow, type: "crypto" })).code).toBe("data_integrity");
  });

  it("rejects an unsafe balance without exposing it", () => {
    const error = caught(() => toAccount({ ...accountRow, balance_cents: UNSAFE_CENTS }));

    expect(error.code).toBe("data_integrity");
    expect(error.message).not.toContain(String(UNSAFE_CENTS));
  });
});

describe("toCategory", () => {
  it("maps a row to the Category DTO and drops is_archived", () => {
    expect(toCategory(categoryRow)).toEqual({
      id: categoryRow.id,
      name: "Groceries",
      kind: "expense",
    });
  });

  it("rejects an unrecognized category kind", () => {
    expect(caught(() => toCategory({ ...categoryRow, kind: "transfer" })).code).toBe("data_integrity");
  });
});

describe("toTransaction", () => {
  it("maps a row to the Transaction DTO", () => {
    expect(toTransaction(transactionRow)).toEqual({
      id: transactionRow.id,
      accountId: accountRow.id,
      date: "2026-08-18",
      merchant: "Whole Foods",
      kind: "expense",
      categoryId: categoryRow.id,
      movementId: undefined,
      amountCents: -8420,
    });
  });

  it("maps a null category_id to undefined — an uncategorized row is legal", () => {
    expect(toTransaction({ ...transactionRow, category_id: null }).categoryId).toBeUndefined();
  });

  it("maps a movement leg's null category_id to undefined and carries movement_id", () => {
    const leg = toTransaction({
      ...transactionRow,
      kind: "transfer",
      category_id: null,
      movement_id: "77777777-7777-4777-8777-777777777777",
      amount_cents: -500_00,
    });

    expect(leg.categoryId).toBeUndefined();
    expect(leg.movementId).toBe("77777777-7777-4777-8777-777777777777");
    expect(leg.kind).toBe("transfer");
  });

  it("never exposes created_at on the DTO", () => {
    const withCreatedAt = { ...transactionRow, created_at: "2026-08-18T12:00:00Z" };

    expect(toTransaction(withCreatedAt)).not.toHaveProperty("created_at");
    expect(toTransaction(withCreatedAt)).not.toHaveProperty("createdAt");
  });

  it("rejects a date that is not a plain calendar date", () => {
    expect(caught(() => toTransaction({ ...transactionRow, date: "2026-08-18T00:00:00Z" })).code).toBe(
      "data_integrity"
    );
  });

  it("rejects an unrecognized transaction kind", () => {
    expect(caught(() => toTransaction({ ...transactionRow, kind: "chargeback" })).code).toBe(
      "data_integrity"
    );
  });

  it("does not leak the merchant name into an error message", () => {
    const error = caught(() =>
      toTransaction({ ...transactionRow, merchant: "Dr Confidential Clinic", amount_cents: UNSAFE_CENTS })
    );

    expect(error.message).not.toContain("Dr Confidential Clinic");
  });
});

describe("toBudget", () => {
  it("maps a row to the Budget DTO", () => {
    expect(toBudget(budgetRow)).toEqual({
      id: budgetRow.id,
      categoryId: categoryRow.id,
      period: "2026-08",
      limitCents: 60000,
    });
  });

  it("rejects a malformed period", () => {
    expect(caught(() => toBudget({ ...budgetRow, period: "2026-8" })).code).toBe("data_integrity");
  });
});

describe("toBill", () => {
  it("maps a row plus its projected due date to the Bill DTO", () => {
    expect(toBill(billRow, "2026-08-19")).toEqual({
      id: billRow.id,
      name: "Electric",
      amountCents: -12000,
      dueDate: "2026-08-19",
      frequency: "monthly",
      categoryId: categoryRow.id,
      accountId: accountRow.id,
    });
  });

  it("maps null category_id and account_id to undefined", () => {
    const bill = toBill({ ...billRow, category_id: null, account_id: null }, "2026-08-19");

    expect(bill.categoryId).toBeUndefined();
    expect(bill.accountId).toBeUndefined();
  });

  it("validates the projected due date, which is not a column on bills", () => {
    for (const value of [null, undefined, "", "2026-08-19T00:00:00Z"]) {
      expect(caught(() => toBill(billRow, value)).code).toBe("data_integrity");
    }
  });

  it("rejects an unrecognized frequency", () => {
    expect(caught(() => toBill({ ...billRow, frequency: "quarterly" }, "2026-08-19")).code).toBe(
      "data_integrity"
    );
  });
});

describe("toGoal", () => {
  it("maps a view row to the Goal DTO", () => {
    expect(toGoal(goalRow)).toEqual({
      id: goalRow.id,
      name: "Emergency Fund",
      targetCents: 1000000,
      savedCents: 425000,
      targetDate: "2026-12-31",
    });
  });

  it("maps a null target_date to undefined — ordering depends on it", () => {
    expect(toGoal({ ...goalRow, target_date: null }).targetDate).toBeUndefined();
  });

  it("maps a zero saved_cents through rather than treating it as absent", () => {
    expect(toGoal({ ...goalRow, saved_cents: 0 }).savedCents).toBe(0);
  });
});

describe("toNetWorthSnapshot", () => {
  it("maps a row to the NetWorthSnapshot DTO", () => {
    expect(toNetWorthSnapshot(snapshotRow)).toEqual({
      month: "2026-08",
      assetsCents: 5000000,
      liabilitiesCents: 1200000,
      netWorthCents: 3800000,
    });
  });

  it("rejects a row whose stored net worth breaks the assets - liabilities identity", () => {
    const error = caught(() => toNetWorthSnapshot({ ...snapshotRow, net_worth_cents: 3_700_000 }));

    expect(error.code).toBe("data_integrity");
    expect(error.message).not.toMatch(/\d{4,}/);
  });

  it("accepts a negative net worth when liabilities exceed assets", () => {
    const snapshot = toNetWorthSnapshot({
      ...snapshotRow,
      assets_cents: 1_000_00,
      liabilities_cents: 3_000_00,
      net_worth_cents: -2_000_00,
    });

    expect(snapshot.netWorthCents).toBe(-200000);
  });
});
