import { describe, expect, it } from "vitest";

import {
  makeCreateTransactionSchema,
  makeUpdateTransactionSchema,
  transactionDeleteSchema,
} from "@/lib/validation/transactions";

/**
 * The transaction schemas, offline and at a fixed date.
 *
 * `today` is a parameter throughout, which is the entire reason these can be
 * tested at all: a validator that read the clock would either need the system
 * date frozen or would quietly change behaviour at midnight — and would
 * disagree with `assert_transaction_refs()`, which computes its own ceiling in
 * the owner's timezone.
 */

const TODAY = "2026-08-27";

const ACCOUNT = "6f4e2f3a-1a2b-4c3d-8e9f-000000000001";
const CATEGORY = "6f4e2f3a-1a2b-4c3d-8e9f-000000000002";
const KEY = "6f4e2f3a-1a2b-4c3d-8e9f-000000000003";

const create = makeCreateTransactionSchema(TODAY);
const update = makeUpdateTransactionSchema(TODAY);

/** A complete, valid create submission — every field as a browser posts it. */
function form(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: KEY,
    accountId: ACCOUNT,
    date: "2026-08-20",
    merchant: "Whole Foods",
    kind: "expense",
    categoryId: CATEGORY,
    amount: "42.50",
    ...overrides,
  };
}

/** The field names that failed, sorted — what `invalid()` would key on. */
function failedFields(result: { success: boolean; error?: unknown }): string[] {
  if (result.success) return [];
  const flattened = (result.error as { issues: { path: (string | number)[] }[] }).issues;
  return [...new Set(flattened.map((issue) => String(issue.path[0])))].sort();
}

describe("makeCreateTransactionSchema", () => {
  it("accepts a complete submission and renames the fields to domain names", () => {
    const result = create.safeParse(form());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: KEY,
      accountId: ACCOUNT,
      date: "2026-08-20",
      merchant: "Whole Foods",
      kind: "expense",
      categoryId: CATEGORY,
      amountCents: -4250,
    });
  });

  it("requires the idempotency key and requires it to be a UUID", () => {
    expect(failedFields(create.safeParse(form({ id: "" })))).toEqual(["id"]);
    expect(failedFields(create.safeParse(form({ id: "not-a-uuid" })))).toEqual(["id"]);
  });

  it("trims the merchant and rejects a blank one", () => {
    expect(create.safeParse(form({ merchant: "  Cafe  " })).data?.merchant).toBe("Cafe");
    expect(failedFields(create.safeParse(form({ merchant: "   " })))).toEqual(["merchant"]);
  });

  it("treats an unselected category as absent rather than as a malformed uuid", () => {
    // An unfilled picker submits "", never undefined. Without the blank→
    // undefined preprocessing this would fail a UUID check on a legal,
    // deliberately uncategorized row.
    const result = create.safeParse(form({ categoryId: "" }));
    expect(result.success).toBe(true);
    expect(result.data?.categoryId).toBeUndefined();
  });
});

describe("sign derivation", () => {
  it("stores an expense negative and income/refund positive", () => {
    expect(create.safeParse(form({ kind: "expense", amount: "10.00" })).data?.amountCents).toBe(-1000);
    expect(create.safeParse(form({ kind: "income", amount: "10.00", categoryId: "" })).data?.amountCents).toBe(1000);
    expect(create.safeParse(form({ kind: "refund", amount: "10.00" })).data?.amountCents).toBe(1000);
  });

  it("keeps a legal zero at exactly zero for every kind, never -0", () => {
    for (const kind of ["income", "expense", "refund"]) {
      const cents = create.safeParse(form({ kind, amount: "0", categoryId: "" })).data?.amountCents;
      expect(cents).toBe(0);
      expect(Object.is(cents, -0)).toBe(false);
    }
  });

  it("refuses a signed amount from the form outright", () => {
    // The direction is the kind's job. A minus sign in the field is ambiguous —
    // a bigger expense, or a refund? — so it is rejected rather than
    // interpreted.
    expect(failedFields(create.safeParse(form({ amount: "-10.00" })))).toEqual(["amount"]);
    expect(failedFields(create.safeParse(form({ kind: "income", amount: "-1" })))).toEqual(["amount"]);
  });

  it("still rejects the money shapes lib/validation/money.ts rejects", () => {
    for (const amount of ["", "abc", "1e5", "10.345", ".50", "12,34"]) {
      expect(failedFields(create.safeParse(form({ amount })))).toEqual(["amount"]);
    }
  });
});

describe("date rules", () => {
  it("accepts today and any past date", () => {
    expect(create.safeParse(form({ date: TODAY })).success).toBe(true);
    expect(create.safeParse(form({ date: "2020-01-01" })).success).toBe(true);
  });

  it("rejects tomorrow, and reports it under the date field", () => {
    const result = create.safeParse(form({ date: "2026-08-28" }));
    expect(result.success).toBe(false);
    expect(failedFields(result)).toEqual(["date"]);
  });

  it("rejects a date that does not exist on the calendar", () => {
    expect(failedFields(create.safeParse(form({ date: "2026-02-30" })))).toEqual(["date"]);
    expect(failedFields(create.safeParse(form({ date: "2026-13-01" })))).toEqual(["date"]);
  });

  it("rejects a date that is not 'YYYY-MM-DD'", () => {
    expect(failedFields(create.safeParse(form({ date: "27/08/2026" })))).toEqual(["date"]);
  });

  it("compares against the `today` it was built with, not the system clock", () => {
    // The whole point of the factory. Built at a past date, the same submission
    // that passes above is now in the future.
    const asOfLastYear = makeCreateTransactionSchema("2025-01-01");
    expect(asOfLastYear.safeParse(form({ date: "2026-08-20" })).success).toBe(false);
    expect(asOfLastYear.safeParse(form({ date: "2024-12-31" })).success).toBe(true);
  });
});

describe("kind rules", () => {
  it("accepts exactly income, expense, and refund", () => {
    for (const kind of ["income", "expense", "refund"]) {
      expect(create.safeParse(form({ kind, categoryId: "" })).success).toBe(true);
    }
  });

  it("refuses movement kinds — a leg cannot be created alone", () => {
    for (const kind of ["transfer", "credit_card_payment"]) {
      expect(failedFields(create.safeParse(form({ kind, categoryId: "" })))).toEqual(["kind"]);
      expect(failedFields(update.safeParse(form({ kind, categoryId: "" })))).toEqual(["kind"]);
    }
  });

  it("refuses `adjustment` on both create and update", () => {
    // Reconciliation is CP5. Refusing it on *update* is what stops the edit
    // form from being a two-step path to writing one; the database refuses the
    // same thing in transactions_update_own_ordinary's WITH CHECK.
    expect(failedFields(create.safeParse(form({ kind: "adjustment", categoryId: "" })))).toEqual(["kind"]);
    expect(failedFields(update.safeParse(form({ kind: "adjustment", categoryId: "" })))).toEqual(["kind"]);
  });

  it("refuses unknown text and an unselected type", () => {
    expect(failedFields(create.safeParse(form({ kind: "" })))).toEqual(["kind"]);
    expect(failedFields(create.safeParse(form({ kind: "Expense" })))).toEqual(["kind"]);
  });
});

describe("makeUpdateTransactionSchema", () => {
  it("accepts a complete submission, with `id` naming the row being edited", () => {
    const result = update.safeParse(form({ id: KEY, kind: "income", categoryId: CATEGORY }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: KEY,
      accountId: ACCOUNT,
      date: "2026-08-20",
      merchant: "Whole Foods",
      kind: "income",
      categoryId: CATEGORY,
      amountCents: 4250,
    });
  });

  it("applies the same date ceiling as create", () => {
    expect(failedFields(update.safeParse(form({ date: "2026-08-28" })))).toEqual(["date"]);
  });

  it("accepts no owner id, on either schema", () => {
    // The rule that must never erode: the owner comes from getOwnerId() inside
    // the mutation DAL, verified from the request's own claims. A form field
    // naming an owner would be an authorization decision made by untrusted
    // input. A supplied one is dropped, never honoured.
    const withOwner = { ...form(), userId: "6f4e2f3a-1a2b-4c3d-8e9f-0000000000ff" };
    expect(create.safeParse(withOwner).data).not.toHaveProperty("userId");
    expect(update.safeParse(withOwner).data).not.toHaveProperty("userId");
  });

  it("accepts no movement id, on either schema", () => {
    const withMovement = { ...form(), movementId: "6f4e2f3a-1a2b-4c3d-8e9f-0000000000fe" };
    expect(create.safeParse(withMovement).data).not.toHaveProperty("movementId");
    expect(update.safeParse(withMovement).data).not.toHaveProperty("movementId");
  });
});

describe("transactionDeleteSchema", () => {
  it("accepts a uuid and nothing else", () => {
    expect(transactionDeleteSchema.safeParse({ id: KEY }).success).toBe(true);
    expect(transactionDeleteSchema.safeParse({ id: "" }).success).toBe(false);
    expect(transactionDeleteSchema.safeParse({ id: "1" }).success).toBe(false);
  });
});

describe("schema factories reject a malformed `today`", () => {
  it("throws at construction rather than validating against a garbage bound", () => {
    // `today` comes from this application, not from the person filling in the
    // form. Comparing against a malformed bound would silently accept or reject
    // everything, so it fails loudly at the call site instead.
    expect(() => makeCreateTransactionSchema("not-a-date")).toThrow();
    expect(() => makeUpdateTransactionSchema("2026/08/27")).toThrow();
  });
});
