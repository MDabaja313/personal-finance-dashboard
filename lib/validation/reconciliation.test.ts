import { describe, expect, it } from "vitest";

import type { AccountType } from "@/lib/types";
import { adjustmentDeleteSchema, makeReconcileSchema } from "@/lib/validation/reconciliation";

/**
 * The reconciliation schemas, offline.
 *
 * Two properties carry most of the weight here, and neither is expressible
 * anywhere else in the stack:
 *
 * 1. **What the balance field means depends on the account's stored type**,
 *    and therefore so does whether a minus sign is acceptable. This is the
 *    only layer where that decision is made, and it is made from a parameter
 *    the *server* supplied — never from the submission.
 * 2. **The surface has no kind, category, movement or amount field at all.**
 *    An adjustment's kind is a literal inside `public.reconcile_account`, and
 *    a reconciliation states a balance rather than an amount. A field added
 *    here would be the first step toward a second transaction entry form.
 *
 * The date ceiling is `zNotFuture(today)`, already covered by
 * `lib/validation/primitives.test.ts`; what is asserted below is that this
 * schema actually applies it, since a dated write that forgot to would be
 * refused only by the trigger, with a message nobody can act on.
 */

const TODAY = "2026-08-29";
const ACCOUNT = "0d0f5e2c-3a5e-4a4a-9b1f-8f4d2b6c1a77";

function parse(accountType: AccountType, fields: Record<string, string>) {
  return makeReconcileSchema({ today: TODAY, accountType }).safeParse({
    accountId: ACCOUNT,
    asOf: TODAY,
    balance: "0",
    ...fields,
  });
}

function fieldErrors(result: ReturnType<typeof parse>): Record<string, string[]> {
  if (result.success) throw new Error("expected the submission to be rejected");
  const flattened: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".");
    (flattened[key] ??= []).push(issue.message);
  }
  return flattened;
}

describe("makeReconcileSchema — asset accounts take a signed actual balance", () => {
  const ASSET_TYPES: AccountType[] = ["checking", "savings", "cash", "investment"];

  it("accepts a positive balance and produces cents", () => {
    for (const accountType of ASSET_TYPES) {
      const result = parse(accountType, { balance: "1,234.56" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.observedCents).toBe(123_456);
    }
  });

  it("accepts a negative balance — an overdrawn account is a real state", () => {
    for (const accountType of ASSET_TYPES) {
      const result = parse(accountType, { balance: "-42.50" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.observedCents).toBe(-4_250);
    }
  });

  it("accepts zero and keeps it exactly 0, never -0", () => {
    const result = parse("checking", { balance: "-0.00" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.observedCents).toBe(0);
      // `Object.is` rather than `===`, because `-0 === 0` is true and `-0`
      // survives into JSON as "-0".
      expect(Object.is(result.data.observedCents, 0)).toBe(true);
    }
  });
});

describe("makeReconcileSchema — liability accounts take a non-negative amount owed", () => {
  const LIABILITY_TYPES: AccountType[] = ["credit", "loan"];

  it("accepts a positive amount owed", () => {
    for (const accountType of LIABILITY_TYPES) {
      const result = parse(accountType, { balance: "450.00" });
      expect(result.success).toBe(true);
      // Still the *typed* magnitude. The negation into an internal balance is
      // the mutation layer's job, from the account's own stored type — this
      // layer deliberately does not perform it, so nothing downstream can be
      // handed a value whose sign has already been decided for it.
      if (result.success) expect(result.data.observedCents).toBe(45_000);
    }
  });

  it("accepts zero owed — a paid-off card", () => {
    for (const accountType of LIABILITY_TYPES) {
      const result = parse(accountType, { balance: "0" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.observedCents).toBe(0);
    }
  });

  it("rejects a negative amount owed, with the message on the balance field", () => {
    for (const accountType of LIABILITY_TYPES) {
      const result = parse(accountType, { balance: "-450.00" });
      expect(fieldErrors(result).balance).toEqual(["Enter an amount of zero or more."]);
    }
  });
});

describe("makeReconcileSchema — the shared rules", () => {
  it("rejects a date after the owner's calendar day", () => {
    const result = parse("checking", { asOf: "2026-08-30" });
    expect(fieldErrors(result).asOf).toEqual(["That date is in the future."]);
  });

  it("accepts the owner's calendar day itself, and any earlier day", () => {
    expect(parse("checking", { asOf: TODAY }).success).toBe(true);
    expect(parse("checking", { asOf: "2020-02-29" }).success).toBe(true);
  });

  it("rejects a date that is not on the calendar", () => {
    expect(fieldErrors(parse("checking", { asOf: "2026-02-30" })).asOf).toEqual([
      "Enter a real calendar date.",
    ]);
  });

  it("rejects an unparseable balance rather than coercing it", () => {
    // Every one of these is a shape `parseMoneyToCents` refuses outright. The
    // point is that reconciliation gets the same refusals every other money
    // field does — a silently coerced balance here would write a wrong
    // adjustment rather than a wrong single transaction.
    for (const balance of ["", "abc", "1e5", "12.345", ".50", "1,2,3"]) {
      expect(parse("checking", { balance }).success).toBe(false);
    }
  });

  it("rejects a malformed account id", () => {
    expect(fieldErrors(parse("checking", { accountId: "not-a-uuid" })).accountId).toEqual([
      "Select a valid option.",
    ]);
  });

  it("reports every failing field at once", () => {
    const errors = fieldErrors(
      parse("credit", { accountId: "nope", asOf: "2026-12-01", balance: "-1.00" })
    );
    expect(Object.keys(errors).sort()).toEqual(["accountId", "asOf", "balance"]);
  });
});

describe("makeReconcileSchema — the fields it deliberately does not have", () => {
  it("ignores a kind, a category, a movement or an amount posted alongside", () => {
    // Zod strips unknown keys by default, so this asserts the *output* shape:
    // nothing a caller invented can reach `ReconcileInput`, and therefore
    // nothing can reach `public.reconcile_account`, whose kind is a SQL
    // literal.
    const result = makeReconcileSchema({ today: TODAY, accountType: "checking" }).safeParse({
      accountId: ACCOUNT,
      asOf: TODAY,
      balance: "10.00",
      kind: "expense",
      categoryId: "3f1b1c9e-9f6d-4a1e-9d3a-0d2f8a1b4c55",
      movementId: "5b2c7d1a-8e4f-4b2c-9a7d-1e3f5a7b9c11",
      amount: "999.99",
      userId: "6c3d8e2b-9f5a-4c3d-8b6e-2f4a6b8c0d22",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["accountId", "asOf", "observedCents"]);
    }
  });
});

describe("adjustmentDeleteSchema", () => {
  it("accepts a uuid and nothing else", () => {
    expect(adjustmentDeleteSchema.safeParse({ id: ACCOUNT }).success).toBe(true);
    expect(adjustmentDeleteSchema.safeParse({ id: "" }).success).toBe(false);
    expect(adjustmentDeleteSchema.safeParse({ id: 7 }).success).toBe(false);
    expect(adjustmentDeleteSchema.safeParse({}).success).toBe(false);
  });
});
