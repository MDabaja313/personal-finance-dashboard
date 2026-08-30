/**
 * Goal contribution form input → validated domain values.
 *
 * A contribution is not "enter a signed amount". A person picks an action —
 * add funds, or a withdrawal/correction — and types a non-negative amount;
 * the sign is derived server-side by `signedContributionAmountFor`
 * (`lib/types/enums.ts`), the same pattern `signedAmountFor` uses for
 * ordinary transactions and for the identical reason: a signed field would
 * let a well-formed submission contradict the action the person actually
 * chose.
 *
 * Built from the CP1 primitives (`zUuid`, `zNotFuture`, `zMoneyCents`,
 * `zOptionalNote`). Pure: Zod and `lib/types` only — no DAL, no clock, no
 * env. ESLint enforces that for `lib/validation/**` and
 * `lib/write-posture.test.ts` proves the fence fires.
 *
 * Two rules this layer deliberately cannot check, because checking them
 * needs a database read: whether the goal exists and belongs to the caller,
 * and whether it is archived. Both are the mutation layer's preflight (for
 * the message) and `assert_goal_contribution_refs()` (for the enforcement).
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL.
 *
 * **`today` is a parameter, so this is a factory** — the same reason every
 * dated schema in this application takes one: the ceiling has to be the
 * owner's own calendar day (`getToday()`, from `profiles.timezone`), so a
 * contribution form's message and `assert_goal_contribution_refs()`'s
 * refusal can never disagree.
 */
import { z } from "zod";

import type { CalendarDate, Cents } from "@/lib/types";
import {
  CONTRIBUTION_ACTIONS,
  signedContributionAmountFor,
  type ContributionAction,
} from "@/lib/types/enums";
import { zMoneyCents } from "@/lib/validation/money";
import { zNotFuture, zOptionalNote, zUuid } from "@/lib/validation/primitives";

/**
 * The contribution form's two-option control, narrowed from the single
 * canonical action list.
 */
export const zContributionAction: z.ZodType<ContributionAction, string> = z
  .string({ error: "Select add funds or a withdrawal/correction." })
  .refine(
    (value): value is ContributionAction =>
      (CONTRIBUTION_ACTIONS as readonly string[]).includes(value),
    { error: "Select add funds or a withdrawal/correction." }
  );

export interface GoalContributionCreateInput {
  readonly id: string;
  readonly goalId: string;
  readonly occurredOn: CalendarDate;
  readonly note?: string;
  /** Already signed by `signedContributionAmountFor` — the form never submits a sign. */
  readonly amountCents: Cents;
}

/**
 * The contribution form, parameterized by the owner's calendar day.
 *
 * `id` is a client-generated idempotency key, used verbatim as the row's
 * `id`: two identical real contributions (the same round deposit made twice
 * in one sitting) are legitimate distinct events, so nothing about the
 * row's contents could tell a retry apart from a second one — only a stable
 * key can (`lib/data/mutations/goal-contributions.ts` explains the retry
 * contract). The amount is a non-negative magnitude; zero survives as zero,
 * since the schema places no `<> 0` constraint on a contribution any more
 * than it does on an ordinary transaction.
 */
export function makeGoalContributionCreateSchema(today: CalendarDate) {
  return z
    .object({
      id: zUuid,
      goalId: zUuid,
      action: zContributionAction,
      amount: zMoneyCents({ allowNegative: false }),
      occurredOn: zNotFuture(today),
      note: zOptionalNote,
    })
    .transform(
      (value): GoalContributionCreateInput => ({
        id: value.id,
        goalId: value.goalId,
        occurredOn: value.occurredOn,
        note: value.note,
        amountCents: signedContributionAmountFor(value.action, value.amount),
      })
    );
}
