/**
 * Text a person typed → integer `Cents`.
 *
 * This is the *only* place a money string is turned into a number in this
 * codebase, and it exists because every convenient way to do it is wrong:
 *
 * - `parseFloat("12.34") * 100` is `1233.9999999999998`. Rounding hides that
 *   for small values and stops hiding it for large ones — the failure is
 *   silent, off by a cent, and lands in stored financial data.
 * - `Number("1e5")` is `100000`. Exponent notation is accepted by every
 *   numeric coercion in JavaScript and by no human writing an amount.
 * - `Number("12.345")` succeeds. A third decimal place is not a rounding
 *   opportunity; it means the person typed something the currency cannot
 *   represent, and quietly rounding it decides on their behalf.
 *
 * So the digits are read as *text* and assembled into a cents integer
 * directly: no float ever exists at any point, and `toCents()` — the same
 * safe-integer guard every DB→TS money value passes through — is the only
 * constructor of the result.
 *
 * Pure: no clock, no env, no I/O, and no `lib/data`/`lib/supabase` import
 * (ESLint enforces all of that for `lib/validation/**`).
 */
import { z } from "zod";

import { toCents, type Cents } from "@/lib/types";

/** Why a money string was rejected. Each maps to its own message. */
export type MoneyIssue =
  /** Nothing but whitespace. */
  | "empty"
  /** Not an amount at all: letters, exponent notation, bad comma grouping, a stray symbol. */
  | "malformed"
  /** More than two decimal places — never silently rounded. */
  | "too_many_decimals"
  /** Well-formed, but outside the safe-integer range `Cents` guarantees. */
  | "out_of_range";

export type MoneyParseResult =
  | { readonly ok: true; readonly cents: Cents }
  | { readonly ok: false; readonly issue: MoneyIssue };

/**
 * An optional sign, an optional `$`, a digit run (optionally comma-grouped),
 * and an optional fraction.
 *
 * The grouping alternative is `\d{1,3}(,\d{3})*` — commas are accepted only in
 * genuine thousands positions, so "1,234,567" parses and "1,2,3"/"12,34" do
 * not. Accepting a comma *anywhere* would silently read "1,2" as 12.
 *
 * Two shapes are deliberately excluded. Exponents ("1e5") cannot match,
 * because no alphabetic character appears in the pattern. A bare fraction
 * (".50") cannot match either: it is far more often a typo or a truncated
 * paste than an intended 50 cents, and rejecting it costs the person one
 * keystroke while accepting it can cost them an order of magnitude.
 *
 * The sign precedes the currency symbol ("-$12.34"). "$-12.34" is rejected;
 * it is not a form anyone types.
 */
const MONEY_PATTERN = /^([-+])?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/;

/**
 * Parses a money string into `Cents`, or explains why it cannot.
 *
 * Returns a result rather than throwing: the caller is a form field, and "the
 * person typed something odd" is an expected outcome, not an exception.
 *
 * Accepts a leading/trailing space, an optional sign, an optional `$`, and
 * thousands commas. The sign is preserved — a negative amount is legitimate
 * for an opening balance or a liability — and callers that require a
 * non-negative figure say so via `zMoneyCents({ allowNegative: false })`
 * rather than by pre-stripping the sign.
 */
export function parseMoneyToCents(input: unknown): MoneyParseResult {
  if (typeof input !== "string") return { ok: false, issue: "malformed" };

  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, issue: "empty" };

  const match = MONEY_PATTERN.exec(trimmed);
  if (!match) return { ok: false, issue: "malformed" };

  const [, sign, whole, fraction] = match;

  // Checked before anything is assembled, so "12.345" is reported as the
  // specific mistake it is rather than as a generic malformed amount.
  if (fraction !== undefined && fraction.length > 2) {
    return { ok: false, issue: "too_many_decimals" };
  }

  // The cents integer, built as a digit string: whole digits with the
  // fraction padded to exactly two places. No float is constructed here or
  // anywhere upstream of here.
  const digits = whole.replace(/,/g, "") + (fraction ?? "").padEnd(2, "0");

  const magnitude = Number(digits);
  // A digit string longer than the safe range yields either an imprecise
  // value or Infinity; both fail this check, and neither can land back inside
  // the safe range, so an over-large amount can never be silently truncated.
  if (!Number.isSafeInteger(magnitude)) return { ok: false, issue: "out_of_range" };

  // `-0` normalized away: it is `=== 0` but stringifies as "-0" and survives
  // into JSON, where it would read as a negative zero balance.
  const signed = sign === "-" && magnitude !== 0 ? -magnitude : magnitude;

  try {
    return { ok: true, cents: toCents(signed) };
  } catch {
    // Unreachable given the check above; kept because `toCents` is the
    // authority on the brand's invariant and this must never throw at a form
    // boundary if that authority ever tightens.
    return { ok: false, issue: "out_of_range" };
  }
}

const ISSUE_MESSAGES: Readonly<Record<MoneyIssue, string>> = Object.freeze({
  empty: "Enter an amount.",
  malformed: "Enter an amount like 1234.56.",
  too_many_decimals: "Enter at most two decimal places.",
  out_of_range: "That amount is too large.",
});

export interface MoneyFieldOptions {
  /**
   * Whether a negative amount is acceptable. Defaults to `false`: most money
   * fields in this application are magnitudes whose direction comes from the
   * transaction's `kind`, not from a typed minus sign.
   */
  readonly allowNegative?: boolean;
}

/**
 * A Zod schema for a money form field: `string` in, branded `Cents` out.
 *
 * Built on `parseMoneyToCents` rather than duplicating it, so a schema and a
 * direct parse can never disagree about what "12.345" means.
 */
export function zMoneyCents(options: MoneyFieldOptions = {}): z.ZodType<Cents, string> {
  const { allowNegative = false } = options;

  return z.string().transform((value, ctx) => {
    const result = parseMoneyToCents(value);

    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: ISSUE_MESSAGES[result.issue] });
      return z.NEVER;
    }

    if (!allowNegative && result.cents < 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount of zero or more." });
      return z.NEVER;
    }

    return result.cents;
  });
}
