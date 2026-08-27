import { describe, expect, it } from "vitest";

import { parseMoneyToCents, zMoneyCents } from "@/lib/validation/money";

/** The cents value, or a failure — collapsed so table tests read cleanly. */
function cents(input: string): number | string {
  const result = parseMoneyToCents(input);
  return result.ok ? result.cents : result.issue;
}

describe("parseMoneyToCents — accepted forms", () => {
  it.each([
    ["0", 0],
    ["0.00", 0],
    ["1", 100],
    ["12.34", 1234],
    ["12.3", 1230],
    ["12.30", 1230],
    ["1234.56", 123456],
    ["0.07", 7],
    ["0.7", 70],
  ])("parses %s as %i cents", (input, expected) => {
    expect(cents(input)).toBe(expected);
  });

  it("accepts the currency symbol, thousands commas, and surrounding space", () => {
    expect(cents("$12.34")).toBe(1234);
    expect(cents("$ 12.34")).toBe(1234);
    expect(cents("  12.34  ")).toBe(1234);
    expect(cents("1,234.56")).toBe(123456);
    expect(cents("$1,234,567.89")).toBe(123456789);
    expect(cents("1234567.89")).toBe(123456789);
  });

  it("preserves a leading sign, before or without the currency symbol", () => {
    expect(cents("-12.34")).toBe(-1234);
    expect(cents("-$12.34")).toBe(-1234);
    expect(cents("+12.34")).toBe(1234);
    expect(cents("-1,234.56")).toBe(-123456);
  });

  it("normalizes negative zero", () => {
    // -0 is `=== 0` but stringifies as "-0" and survives JSON, where it would
    // read as a negative zero balance.
    const result = parseMoneyToCents("-0.00");
    expect(result.ok && Object.is(result.cents, 0)).toBe(true);
    expect(result.ok && Object.is(result.cents, -0)).toBe(false);
  });
});

describe("parseMoneyToCents — no float ever exists", () => {
  it("is exact for the values a float round-trip corrupts", () => {
    // parseFloat("12.34") * 100 === 1233.9999999999998; Math.round hides it
    // here and stops hiding it further out. Text assembly is exact at every
    // magnitude.
    expect(cents("12.34")).toBe(1234);
    expect(cents("1.10")).toBe(110);
    expect(cents("1.15")).toBe(115);
    expect(cents("8.20")).toBe(820);
    expect(cents("70.07")).toBe(7007);
    expect(cents("90071992547.40")).toBe(9007199254740);
  });

  it("is exact at the top of the safe-integer range", () => {
    // 90071992547409.91 -> 9007199254740991 === Number.MAX_SAFE_INTEGER.
    expect(cents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("parseMoneyToCents — rejected forms", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "malformed"],
    ["12abc", "malformed"],
    ["$", "malformed"],
    ["-", "malformed"],
    [".", "malformed"],
    ["12.", "malformed"],
    ["1.2.3", "malformed"],
    ["12,34", "malformed"],
    ["1,2,3", "malformed"],
    ["1234,567", "malformed"],
    ["12 34", "malformed"],
    ["$-12.34", "malformed"],
    ["(12.34)", "malformed"],
    ["12.34USD", "malformed"],
    ["Infinity", "malformed"],
    ["NaN", "malformed"],
  ])("rejects %o as %s", (input, issue) => {
    expect(cents(input)).toBe(issue);
  });

  it("rejects exponent notation in every casing", () => {
    // Number("1e5") is 100000 — a coercion this parser must never inherit.
    for (const input of ["1e5", "1E5", "1e-5", "1.2e3", "12.34e2"]) {
      expect(cents(input)).toBe("malformed");
    }
  });

  it("rejects a bare fraction with no whole part", () => {
    // More often a typo or a truncated paste than an intended 50 cents.
    expect(cents(".50")).toBe("malformed");
    expect(cents("-.50")).toBe("malformed");
  });

  it("rejects more than two decimal places rather than rounding", () => {
    expect(cents("12.345")).toBe("too_many_decimals");
    expect(cents("0.001")).toBe("too_many_decimals");
    expect(cents("12.3456789")).toBe("too_many_decimals");
  });

  it("rejects an amount past the safe-integer range instead of truncating", () => {
    // 90071992547409.92 -> 9007199254740992, one past MAX_SAFE_INTEGER.
    expect(cents("90071992547409.92")).toBe("out_of_range");
    expect(cents("999999999999999999999.99")).toBe("out_of_range");
    expect(cents("-999999999999999999999.99")).toBe("out_of_range");
  });

  it("rejects non-string input rather than coercing it", () => {
    // A FormData entry can be a File, and a hand-crafted request can post
    // anything at all.
    for (const value of [12.34, null, undefined, {}, [], true]) {
      const result = parseMoneyToCents(value);
      expect(result.ok).toBe(false);
    }
  });
});

describe("zMoneyCents", () => {
  it("outputs branded cents for a valid amount", () => {
    const parsed = zMoneyCents().safeParse("$1,234.56");
    expect(parsed.success && parsed.data).toBe(123456);
  });

  it("rejects a negative amount by default, with an actionable message", () => {
    const parsed = zMoneyCents().safeParse("-1.00");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Enter an amount of zero or more.");
  });

  it("accepts a negative amount when the field allows one", () => {
    const parsed = zMoneyCents({ allowNegative: true }).safeParse("-1.00");
    expect(parsed.success && parsed.data).toBe(-100);
  });

  it("surfaces the specific issue as the field message", () => {
    expect(zMoneyCents().safeParse("12.345").error?.issues[0]?.message).toBe(
      "Enter at most two decimal places."
    );
    expect(zMoneyCents().safeParse("").error?.issues[0]?.message).toBe("Enter an amount.");
    expect(zMoneyCents().safeParse("abc").error?.issues[0]?.message).toBe(
      "Enter an amount like 1234.56."
    );
  });

  it("never quotes the rejected input back in the message", () => {
    // A field message is rendered into the page; the amount someone typed is
    // theirs, but echoing raw input into an error string is how injection and
    // accidental disclosure start. The messages are constants.
    const parsed = zMoneyCents().safeParse("99999.999");
    expect(parsed.error?.issues[0]?.message).not.toContain("99999");
  });
});
