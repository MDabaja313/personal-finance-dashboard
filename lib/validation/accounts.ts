/**
 * Account form input → validated domain values.
 *
 * Built entirely from the CP1 primitives (`zName`, `zUuid`, `zMoneyCents`,
 * `parseMoneyToCents`) plus the one enum list in `lib/types/enums.ts`, so a
 * label set or a money rule has exactly one definition. Pure: Zod and
 * `lib/types` only — no DAL, no clock, no env. ESLint enforces that for
 * `lib/validation/**` and `lib/write-posture.test.ts` proves the fence fires.
 *
 * ## What this layer is and is not
 *
 * It is a UX layer. Every rule here is also enforced by the database — the
 * `accounts_credit_limit_domain_ck` / `accounts_interest_rate_domain_ck` /
 * `*_nonneg_ck` CHECK constraints, the column-scoped GRANT, the ownership RLS
 * policies, and `accounts_guard_update()` — and the database remains the final
 * authority. What validation buys is a message a person can act on *before* a
 * query is issued, rather than a generic "that is not valid" after one.
 *
 * ## Three decisions worth stating outright
 *
 * **No owner id is accepted from the caller, ever.** There is no `userId` field
 * on any schema here and there must never be one: the owner comes from
 * `getOwnerId()` inside the mutation DAL, verified from the request's own
 * claims. A form field naming an owner would be an authorization decision made
 * by untrusted input.
 *
 * **The opening balance is signed, and that is the existing convention, not a
 * new one.** `accounts.opening_balance_cents` is stored signed — assets
 * positive, liabilities (credit/loan) negative — which is what
 * `lib/finance/accounts.ts` and every seeded row already assume. So the field
 * accepts a negative amount rather than deriving a sign from the account type.
 * Reconciling "the amount you owe" into a stored negative is an entry/display
 * question the roadmap assigns to CP5; inventing an answer here would leave two
 * competing sign models in one column.
 *
 * **APR is entered as a percentage and stored as basis points.** The column is
 * `interest_rate_bps` (integer, 1899 = 18.99%) and `AccountCard` renders it as
 * `bps / 100`. A percentage with two decimal places *is* a basis-point integer,
 * which is the same "text with two decimals → integer, with no float ever
 * constructed" problem `parseMoneyToCents` already solves — so that parser is
 * reused rather than reimplemented, with rate-specific wording.
 */
import { z } from "zod";

import type { AccountType, Cents } from "@/lib/types";
import { ACCOUNT_TYPES, allowsCreditLimit, allowsInterestRate } from "@/lib/types/enums";
import { parseMoneyToCents, zMoneyCents } from "@/lib/validation/money";
import { NAME_MAX_LENGTH, blankToUndefined, zName, zUuid } from "@/lib/validation/primitives";

/**
 * The institution a person banks with. Same shape as `zName` but with its own
 * wording, because "Enter a name." under an Institution field reads as a bug.
 */
export const zInstitution = z
  .string({ error: "Enter an institution." })
  .trim()
  .min(1, { error: "Enter an institution." })
  .max(NAME_MAX_LENGTH, { error: `Use ${NAME_MAX_LENGTH} characters or fewer.` });

/** `public.account_type`, narrowed from the single canonical label list. */
export const zAccountType: z.ZodType<AccountType, string> = z
  .string({ error: "Select an account type." })
  .refine((value): value is AccountType => (ACCOUNT_TYPES as readonly string[]).includes(value), {
    error: "Select an account type.",
  });

/**
 * A percentage a person typed ("23.99") → integer basis points (2399).
 *
 * Delegates the digit handling to `parseMoneyToCents`, whose entire purpose is
 * turning two-decimal text into an integer without a float existing at any
 * point — the identical requirement here. Only the messages differ, and a
 * negative value is rejected outright: a negative APR is not a rate, and
 * `accounts_interest_rate_nonneg_ck` would refuse it anyway.
 */
export const zBasisPoints: z.ZodType<number, string> = z.string().transform((value, ctx) => {
  const result = parseMoneyToCents(value);

  if (!result.ok) {
    ctx.addIssue({
      code: "custom",
      message:
        result.issue === "too_many_decimals"
          ? "Enter a rate with at most two decimal places."
          : result.issue === "out_of_range"
            ? "That rate is too large."
            : "Enter a rate like 23.99.",
    });
    return z.NEVER;
  }

  if (result.cents < 0) {
    ctx.addIssue({ code: "custom", message: "Enter a rate of zero or more." });
    return z.NEVER;
  }

  // `Cents` is the parser's brand, not this value's meaning — basis points are
  // not money and must never carry that brand. The read side keeps the same
  // separation, mapping this column with `integerFrom` rather than `centsFrom`.
  return Number(result.cents);
});

/** Blank → absent, otherwise a non-negative basis-point rate. */
const zOptionalBasisPoints = z.preprocess(blankToUndefined, zBasisPoints.optional());

/**
 * Blank → absent, otherwise a non-negative credit limit.
 *
 * Non-negative, unlike the opening balance: a credit limit is a magnitude
 * ("how much room is on this card"), and `accounts_credit_limit_nonneg_ck`
 * says the same in the database.
 */
const zOptionalCreditLimit = z.preprocess(
  blankToUndefined,
  zMoneyCents({ allowNegative: false }).optional()
);

/**
 * The starting balance, signed — see the module note. A credit card or loan
 * opens at a negative figure, and that is the convention already stored in
 * every seeded row.
 */
const zOpeningBalance = zMoneyCents({ allowNegative: true });

/**
 * Reports the two domain-restricted fields when they were supplied for a type
 * that cannot carry them.
 *
 * Reported rather than silently dropped, deliberately: a person who filled in
 * a credit limit and then switched the type to Checking should be told the
 * field no longer applies, not have their input quietly discarded. `path` names
 * the form control, so `z.flattenError` files the message under the right input.
 */
function checkTypeDomain(
  type: AccountType,
  creditLimitCents: Cents | undefined,
  interestRateBps: number | undefined,
  ctx: z.RefinementCtx
): void {
  if (creditLimitCents !== undefined && !allowsCreditLimit(type)) {
    ctx.addIssue({
      code: "custom",
      path: ["creditLimit"],
      message: "A credit limit applies to credit accounts only.",
    });
  }

  if (interestRateBps !== undefined && !allowsInterestRate(type)) {
    ctx.addIssue({
      code: "custom",
      path: ["interestRate"],
      message: "An interest rate applies to credit and loan accounts only.",
    });
  }
}

export interface AccountCreateInput {
  readonly name: string;
  readonly institution: string;
  readonly type: AccountType;
  readonly openingBalanceCents: Cents;
  readonly creditLimitCents?: Cents;
  readonly interestRateBps?: number;
}

/**
 * The create form. The object keys are the form control `name`s, so
 * `z.flattenError(...).fieldErrors` can be handed straight to `invalid()` and
 * land under the right input; the transform renames them to the domain field
 * names the mutation layer takes.
 */
export const accountCreateSchema = z
  .object({
    name: zName,
    institution: zInstitution,
    type: zAccountType,
    openingBalance: zOpeningBalance,
    creditLimit: zOptionalCreditLimit,
    interestRate: zOptionalBasisPoints,
  })
  .transform((value, ctx): AccountCreateInput => {
    checkTypeDomain(value.type, value.creditLimit, value.interestRate, ctx);

    return {
      name: value.name,
      institution: value.institution,
      type: value.type,
      openingBalanceCents: value.openingBalance,
      creditLimitCents: value.creditLimit,
      interestRateBps: value.interestRate,
    };
  });

export interface AccountUpdateInput {
  readonly id: string;
  readonly name: string;
  readonly institution: string;
  /** Absent means "leave the stored opening balance alone" — see below. */
  readonly openingBalanceCents?: Cents;
  readonly creditLimitCents?: Cents;
  readonly interestRateBps?: number;
}

/**
 * The edit form, parameterized by the account's **current** type.
 *
 * A factory rather than a plain schema, because `type` is immutable — it is not
 * in the CP2 UPDATE grant, and `accounts_guard_update()` rejects a change
 * regardless. The domain rules for credit limit and interest rate must
 * therefore be judged against the type the row already has, never against a
 * type resubmitted from the browser. The caller reads that type back through
 * the DAL, which is also what turns a deleted or foreign id into a clean "no
 * longer exists" instead of a database error.
 *
 * ## Why the opening balance is optional here and required on create
 *
 * The `Account` DTO carries the *derived* balance (opening + SUM of the
 * ledger), not the stored opening figure — that is the whole point of reading
 * through the `account_balances` view. So an edit form has nothing to prefill
 * this field with, and prefilling it with the derived balance would be worse
 * than leaving it empty: it would silently restate the account's history the
 * moment someone saved a form they only meant to rename.
 *
 * Blank therefore means "leave it as it is", and the mutation layer omits the
 * column entirely in that case. Widening the DTO instead was considered and
 * rejected for CP2: `Account.openingBalanceCents` would have to be mirrored in
 * the fixture oracle, which stores derived balances and cannot reproduce the
 * back-computed opening figures the seed generates — so the parity suite would
 * be asserting against a number it had to invent.
 */
export function accountUpdateSchema(type: AccountType) {
  return z
    .object({
      id: zUuid,
      name: zName,
      institution: zInstitution,
      openingBalance: z.preprocess(blankToUndefined, zOpeningBalance.optional()),
      creditLimit: zOptionalCreditLimit,
      interestRate: zOptionalBasisPoints,
    })
    .transform((value, ctx): AccountUpdateInput => {
      checkTypeDomain(type, value.creditLimit, value.interestRate, ctx);

      return {
        id: value.id,
        name: value.name,
        institution: value.institution,
        openingBalanceCents: value.openingBalance,
        creditLimitCents: value.creditLimit,
        interestRateBps: value.interestRate,
      };
    });
}

/**
 * Archive/unarchive. Just the row id and the target state — whether archiving
 * is *allowed* depends on the account's derived balance, which is not a
 * property of the input, so that rule lives in the mutation DAL and in
 * `accounts_guard_update()`.
 *
 * `archived` arrives as the string a hidden input carries. It is compared
 * against the literal "true" rather than coerced: `Boolean("false")` is `true`,
 * and a coercion bug here would silently invert an archive.
 */
export const accountArchiveSchema = z.object({
  id: zUuid,
  archived: z
    .string({ error: "Select a state." })
    .refine((value) => value === "true" || value === "false", { error: "Select a state." })
    .transform((value) => value === "true"),
});
