/**
 * Monthly-plan form input → validated domain values.
 *
 * The application only ever manages the owner's **current** month, so `period`
 * is never a field this layer parses from untrusted input — it is injected by
 * the Server Action from `getToday()`, exactly as `lib/validation/budgets.ts`
 * does it. Accepting a client-supplied period would let a hand-crafted request
 * set a target for a month the UI never shows.
 *
 * Built from the CP1 primitives (`zUuid`, `zMoneyCents`). Pure: Zod and
 * `lib/types` only — no DAL, no clock, no env. ESLint enforces that for
 * `lib/validation/**` and `lib/write-posture.test.ts` proves the fence fires.
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL.
 *
 * ## Expected income is a magnitude, and there is no kind to derive a sign from
 *
 * Unlike a transaction amount, this field has no direction: "I expect to earn
 * £4,000" is the whole statement. `zMoneyCents({ allowNegative: false })`
 * therefore rejects a minus sign outright rather than deriving anything from
 * it, and `monthly_plans_expected_income_nonneg_ck` is the database's own
 * statement of the same rule.
 *
 * Zero is legal and is deliberately not the same as *not set*: zero says "I
 * expect no income this month", which makes every planned expense unallocated
 * and is a real thing to plan. "Not set" is the absence of a row, and there is
 * no schema for it here — clearing a plan is a separate delete.
 */
import { z } from "zod";

import type { Cents, MonthKey } from "@/lib/types";
import { zMoneyCents } from "@/lib/validation/money";
import { zUuid } from "@/lib/validation/primitives";

export interface MonthlyPlanInput {
  readonly id: string;
  readonly period: MonthKey;
  /** Non-negative. Zero is legal and means "no income expected". */
  readonly expectedIncomeCents: Cents;
}

/**
 * The set/edit form, parameterized by the owner's current month.
 *
 * One schema for both, because there is one operation: the mutation layer
 * upserts by the natural key `(user_id, period)`. `id` is a client-minted
 * idempotency key used verbatim as the row's `id` on the insert path — the same
 * arrangement every other create surface here uses, and what makes a retry
 * collide with itself on the primary key rather than race the natural key.
 */
export function makeMonthlyPlanSchema(period: MonthKey) {
  return z
    .object({
      id: zUuid,
      expectedIncome: zMoneyCents({ allowNegative: false }),
    })
    .transform(
      (value): MonthlyPlanInput => ({
        id: value.id,
        period,
        expectedIncomeCents: value.expectedIncome,
      })
    );
}

/**
 * There is deliberately no schema for clearing a plan.
 *
 * Clearing takes no input at all: the row is addressed by the owner (from
 * `getOwnerId()`) and the period (derived by the Server Action from
 * `getToday()`), so a hand-crafted request has nothing to point at and no field
 * to get wrong. A one-field "id" schema would add an attack surface — an
 * addressable row id — in exchange for nothing.
 */
