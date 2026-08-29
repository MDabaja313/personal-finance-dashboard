/**
 * Goal form input → validated domain values.
 *
 * Built from the CP1 primitives (`zName`, `zUuid`, `zCalendarDate`,
 * `zMoneyCents`, `blankToUndefined`). Pure: Zod and `lib/types` only — no
 * DAL, no clock, no env. ESLint enforces that for `lib/validation/**` and
 * `lib/write-posture.test.ts` proves the fence fires.
 *
 * Every rule here is also enforced by the database (`goals_target_positive_ck`,
 * the column-scoped GRANT, the ownership RLS policies), and the database
 * remains the final authority.
 *
 * **No owner id is accepted from the caller, ever.** The owner comes from
 * `getOwnerId()` inside the mutation DAL.
 *
 * **No `archived_at` here.** Archiving/unarchiving is a distinct, one-field
 * action (`goalArchiveSchema`, below) — mixing it into the create/edit
 * schema would let an edit silently change archive state as a side effect
 * of an unrelated save.
 *
 * **The target date carries no restriction beyond being a real calendar
 * date.** A goal with no target date, a past one, or a far-future one are
 * all legitimate — `goalProgress()` (`lib/finance/goals.ts`) already handles
 * an absent or elapsed target date without a validation-layer opinion about
 * which dates are acceptable.
 */
import { z } from "zod";

import type { CalendarDate, Cents } from "@/lib/types";
import { zMoneyCents } from "@/lib/validation/money";
import { blankToUndefined, zCalendarDate, zName, zUuid } from "@/lib/validation/primitives";

/**
 * A strictly positive target amount — the TypeScript mirror of
 * `goals_target_positive_ck`. `zMoneyCents({ allowNegative: false })` alone
 * would still admit zero, which this schema's own CHECK constraint refuses.
 */
const zGoalTarget: z.ZodType<Cents, string> = zMoneyCents({ allowNegative: false }).refine(
  (cents) => cents > 0,
  { error: "Enter a target greater than zero." }
);

/** Blank → absent, otherwise a real calendar date. No "not in the past" rule. */
const zOptionalTargetDate = z.preprocess(blankToUndefined, zCalendarDate.optional());

/** The fields create and edit share. */
const goalFields = {
  name: zName,
  target: zGoalTarget,
  targetDate: zOptionalTargetDate,
};

export interface GoalCreateInput {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  readonly targetDate?: CalendarDate;
}

/**
 * The create form. `id` is a client-generated idempotency key, used verbatim
 * as the row's `id` — the same arrangement as every other create surface in
 * this application (`lib/data/mutations/goals.ts` explains the retry
 * contract).
 */
export const goalCreateSchema = z
  .object({ id: zUuid, ...goalFields })
  .transform(
    (value): GoalCreateInput => ({
      id: value.id,
      name: value.name,
      targetCents: value.target,
      targetDate: value.targetDate,
    })
  );

export interface GoalUpdateInput {
  readonly id: string;
  readonly name: string;
  readonly targetCents: Cents;
  readonly targetDate?: CalendarDate;
}

/**
 * The edit form. Structurally identical to create apart from what `id`
 * means. Every editable column is resubmitted whole, including while the
 * goal is archived — editing a goal's own metadata never touches a
 * contribution row, so there is nothing for archiving to protect here. A
 * target may be edited below the currently saved amount: an over-funded
 * goal is already a legal, displayed state (`goalProgress()` reports
 * progress over 100%).
 */
export const goalUpdateSchema = z
  .object({ id: zUuid, ...goalFields })
  .transform(
    (value): GoalUpdateInput => ({
      id: value.id,
      name: value.name,
      targetCents: value.target,
      targetDate: value.targetDate,
    })
  );

/**
 * Archive/unarchive. Same string-literal comparison as
 * `accountArchiveSchema`, for the same reason: `Boolean("false")` is `true`,
 * and a coercion bug here would silently invert an archive.
 */
export const goalArchiveSchema = z.object({
  id: zUuid,
  archived: z
    .string({ error: "Select a state." })
    .refine((value) => value === "true" || value === "false", { error: "Select a state." })
    .transform((value) => value === "true"),
});
