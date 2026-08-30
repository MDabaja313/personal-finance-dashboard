/**
 * Budget form input → validated domain values.
 *
 * The application only ever manages the owner's **current** month, so
 * `period` is never a field this layer parses from untrusted input — it is
 * injected by the Server Action from `getToday()`, exactly as `today` is
 * injected into `zNotFuture`. Accepting a client-supplied period would let a
 * hand-crafted request manage a month the UI never shows.
 *
 * Built from the CP1 primitives (`zUuid`, `zMoneyCents`). Pure: Zod and
 * `lib/types` only — no DAL, no clock, no env. ESLint enforces that for
 * `lib/validation/**` and `lib/write-posture.test.ts` proves the fence fires.
 *
 * Every rule here is also enforced by the database — `budgets_limit_nonneg_ck`,
 * the `(user_id, category_id, period)` UNIQUE constraint, the column-scoped
 * GRANT, and `assert_budget_category_active_expense()` — and the database
 * remains the final authority. This layer only rejects what it can see
 * without a query: category ownership, activeness, and kind are not
 * something a validator can check without a database read, so they are the
 * mutation layer's preflight and the trigger's job.
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL.
 */
import { z } from "zod";

import type { Cents, MonthKey } from "@/lib/types";
import { zMoneyCents } from "@/lib/validation/money";
import { zUuid } from "@/lib/validation/primitives";

export interface BudgetCreateInput {
  readonly id: string;
  readonly categoryId: string;
  readonly period: MonthKey;
  /** Zero is legal — the existing schema's CHECK is `>= 0`, not `> 0`. */
  readonly limitCents: Cents;
}

/**
 * The create form, parameterized by the owner's current month.
 *
 * `id` is validated as a UUID like any other untrusted field — it arrives
 * from a hidden input, minted once per mounted form so a retry collides with
 * itself on the primary key rather than risking a second budget for the same
 * category and month (`lib/data/mutations/budgets.ts` turns that collision
 * into a successful retry or a `conflict`, never a blind success).
 */
export function makeBudgetCreateSchema(period: MonthKey) {
  return z
    .object({
      id: zUuid,
      categoryId: zUuid,
      limit: zMoneyCents({ allowNegative: false }),
    })
    .transform(
      (value): BudgetCreateInput => ({
        id: value.id,
        categoryId: value.categoryId,
        period,
        limitCents: value.limit,
      })
    );
}

export interface BudgetUpdateInput {
  readonly id: string;
  readonly limitCents: Cents;
}

/**
 * The edit form. Limit only — `category_id` and `period` decide what the
 * budget fundamentally *is* and are not in the CP6 UPDATE grant at all;
 * getting either wrong means deleting the budget and creating the right one,
 * never rewriting it in place.
 */
export const budgetUpdateSchema = z
  .object({ id: zUuid, limit: zMoneyCents({ allowNegative: false }) })
  .transform((value): BudgetUpdateInput => ({ id: value.id, limitCents: value.limit }));

/**
 * Delete. Just the row id — a budget is planning metadata, not ledger
 * history, so there is no guard to parameterize this with.
 */
export const budgetDeleteSchema = z.object({ id: zUuid });
