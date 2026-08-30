import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountArchiveSchema,
  accountCreateSchema,
  accountUpdateSchema,
  zBasisPoints,
} from "@/lib/validation/accounts";

/**
 * Offline unit tests for the account schemas.
 *
 * These are the *input* side of the same invariants the database enforces, so
 * the cases worth writing down are the ones where a wrong answer would be
 * silent: a rate that quietly loses precision, a domain-restricted field
 * accepted on the wrong account type, an archive flag coerced the wrong way.
 */

const VALID_CREATE = {
  name: "  Everyday Checking  ",
  institution: " Horizon Bank ",
  type: "checking",
  openingBalance: "1,234.56",
  creditLimit: "",
  interestRate: "",
};

function fieldErrors(error: z.ZodError): Record<string, string[] | undefined> {
  return z.flattenError(error).fieldErrors;
}

describe("zBasisPoints", () => {
  it("reads a percentage as an exact basis-point integer", () => {
    // 23.99% is 2399bp. Via a float, 23.99 * 100 is 2398.9999999999995.
    expect(zBasisPoints.parse("23.99")).toBe(2399);
    expect(zBasisPoints.parse("6.49")).toBe(649);
    expect(zBasisPoints.parse("0")).toBe(0);
    expect(zBasisPoints.parse("7")).toBe(700);
    expect(zBasisPoints.parse("7.5")).toBe(750);
  });

  it("rejects a third decimal place rather than rounding it away", () => {
    expect(zBasisPoints.safeParse("23.995").success).toBe(false);
  });

  it("rejects a negative rate", () => {
    expect(zBasisPoints.safeParse("-1").success).toBe(false);
  });

  it("rejects text that is not a rate", () => {
    for (const input of ["", "abc", "1e5", "%"]) {
      expect(zBasisPoints.safeParse(input).success, input).toBe(false);
    }
  });
});

describe("accountCreateSchema", () => {
  it("trims text and produces integer cents", () => {
    const parsed = accountCreateSchema.parse(VALID_CREATE);

    expect(parsed).toEqual({
      name: "Everyday Checking",
      institution: "Horizon Bank",
      type: "checking",
      openingBalanceCents: 123456,
      creditLimitCents: undefined,
      interestRateBps: undefined,
    });
  });

  it("accepts a negative opening balance — the stored convention is signed", () => {
    const parsed = accountCreateSchema.parse({
      ...VALID_CREATE,
      type: "credit",
      openingBalance: "-1284.50",
      creditLimit: "5000",
      interestRate: "23.99",
    });

    expect(parsed.openingBalanceCents).toBe(-128450);
    expect(parsed.creditLimitCents).toBe(500000);
    expect(parsed.interestRateBps).toBe(2399);
  });

  it("rejects a blank name or institution", () => {
    const result = accountCreateSchema.safeParse({
      ...VALID_CREATE,
      name: "   ",
      institution: "",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrors(result.error).name).toBeDefined();
    expect(fieldErrors(result.error).institution).toBeDefined();
  });

  it("rejects an unknown account type", () => {
    expect(accountCreateSchema.safeParse({ ...VALID_CREATE, type: "crypto" }).success).toBe(false);
  });

  it("reports a credit limit on a non-credit account under that field", () => {
    // Mirrors accounts_credit_limit_domain_ck. Reported rather than dropped:
    // silently discarding it would leave the person believing it was stored.
    const result = accountCreateSchema.safeParse({ ...VALID_CREATE, creditLimit: "5000" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrors(result.error).creditLimit).toHaveLength(1);
  });

  it("reports an interest rate on an account type that cannot carry one", () => {
    // Mirrors accounts_interest_rate_domain_ck: credit and loan only.
    const result = accountCreateSchema.safeParse({
      ...VALID_CREATE,
      type: "savings",
      interestRate: "1.5",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrors(result.error).interestRate).toHaveLength(1);

    expect(
      accountCreateSchema.safeParse({ ...VALID_CREATE, type: "loan", interestRate: "6.49" }).success
    ).toBe(true);
  });

  it("rejects a negative credit limit", () => {
    const result = accountCreateSchema.safeParse({
      ...VALID_CREATE,
      type: "credit",
      creditLimit: "-1",
    });

    expect(result.success).toBe(false);
  });

  describe("FormData semantics: a control that is not rendered", () => {
    // `<Input name="creditLimit">` and `<Input name="interestRate">` in
    // AccountForm are only mounted when `allowsCreditLimit`/`allowsInterestRate`
    // say the selected type can carry them (see account-form.tsx). For every
    // other type — savings, checking, cash, investment — those controls never
    // exist in the DOM, so `formData.get("creditLimit")` returns `null`, not
    // `""`. `blankToUndefined` must collapse both to `undefined`; a schema that
    // only normalizes `""` leaves `null` to fail `zMoneyCents`/`zBasisPoints`,
    // which is the exact production bug reported against /accounts.

    it("accepts the exact production repro: a savings account with null optional fields", () => {
      const result = accountCreateSchema.safeParse({
        name: "Savings",
        institution: "Personal",
        type: "savings",
        openingBalance: "105.00",
        creditLimit: null,
        interestRate: null,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.openingBalanceCents).toBe(10500);
      expect(result.data.creditLimitCents).toBeUndefined();
      expect(result.data.interestRateBps).toBeUndefined();
    });

    it("accepts a checking account submitted with both optional controls absent (null)", () => {
      const result = accountCreateSchema.safeParse({
        name: "Everyday Checking",
        institution: "Horizon Bank",
        type: "checking",
        openingBalance: "1234.56",
        creditLimit: null,
        interestRate: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts a cash account submitted with both optional controls absent (null)", () => {
      const result = accountCreateSchema.safeParse({
        name: "Wallet",
        institution: "Personal",
        type: "cash",
        openingBalance: "20.00",
        creditLimit: null,
        interestRate: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts an investment account submitted with both optional controls absent (null)", () => {
      const result = accountCreateSchema.safeParse({
        name: "Brokerage",
        institution: "Personal",
        type: "investment",
        openingBalance: "5000.00",
        creditLimit: null,
        interestRate: null,
      });

      expect(result.success).toBe(true);
    });

    it("still accepts credit with both domain fields present, unaffected by the null fix", () => {
      const result = accountCreateSchema.safeParse({
        name: "Rewards Card",
        institution: "Personal",
        type: "credit",
        openingBalance: "-500.00",
        creditLimit: "5000.00",
        interestRate: "23.99",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.creditLimitCents).toBe(500000);
      expect(result.data.interestRateBps).toBe(2399);
    });

    it("still accepts loan with interestRate present and creditLimit absent (null)", () => {
      const result = accountCreateSchema.safeParse({
        name: "Auto Loan",
        institution: "Personal",
        type: "loan",
        openingBalance: "-12000.00",
        creditLimit: null,
        interestRate: "6.49",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.creditLimitCents).toBeUndefined();
      expect(result.data.interestRateBps).toBe(649);
    });

    it("still produces an actionable field error when a visible field is actually invalid", () => {
      // A null optional field must not mask a real problem elsewhere: a blank
      // name on the same savings submission still fails, and still fails under
      // "name" specifically rather than collapsing to a form-only error.
      const result = accountCreateSchema.safeParse({
        name: "",
        institution: "Personal",
        type: "savings",
        openingBalance: "105.00",
        creditLimit: null,
        interestRate: null,
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(fieldErrors(result.error).name).toBeDefined();
    });
  });
});

describe("accountUpdateSchema", () => {
  const VALID_UPDATE = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Renamed",
    institution: "Horizon Bank",
    openingBalance: "",
    creditLimit: "",
    interestRate: "",
  };

  it("treats a blank opening balance as 'leave it alone'", () => {
    // The Account DTO exposes the derived balance, not the stored opening
    // figure, so an edit form has nothing to prefill this with. Blank must mean
    // unchanged — never zero.
    const parsed = accountUpdateSchema("checking").parse(VALID_UPDATE);

    expect(parsed.openingBalanceCents).toBeUndefined();
    expect(parsed.name).toBe("Renamed");
  });

  it("parses a supplied opening balance", () => {
    const parsed = accountUpdateSchema("checking").parse({
      ...VALID_UPDATE,
      openingBalance: "500.25",
    });

    expect(parsed.openingBalanceCents).toBe(50025);
  });

  it("judges the domain fields against the account's current type, not a submitted one", () => {
    // `type` is immutable and is not even a field here — the caller supplies
    // the stored type, so a browser cannot widen what it is allowed to send.
    expect(
      accountUpdateSchema("credit").safeParse({ ...VALID_UPDATE, creditLimit: "5000" }).success
    ).toBe(true);
    expect(
      accountUpdateSchema("checking").safeParse({ ...VALID_UPDATE, creditLimit: "5000" }).success
    ).toBe(false);
  });

  it("rejects a malformed id", () => {
    expect(accountUpdateSchema("checking").safeParse({ ...VALID_UPDATE, id: "nope" }).success).toBe(
      false
    );
  });
});

describe("accountArchiveSchema", () => {
  it("reads the target state from the literal string", () => {
    const id = "11111111-1111-4111-8111-111111111111";

    expect(accountArchiveSchema.parse({ id, archived: "true" }).archived).toBe(true);
    // The case a coercion would get wrong: Boolean("false") is true.
    expect(accountArchiveSchema.parse({ id, archived: "false" }).archived).toBe(false);
  });

  it("rejects anything that is not exactly 'true' or 'false'", () => {
    const id = "11111111-1111-4111-8111-111111111111";

    for (const archived of ["", "yes", "1", "TRUE"]) {
      expect(accountArchiveSchema.safeParse({ id, archived }).success, archived).toBe(false);
    }
  });
});
