import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { calendarDateOrUndefined, centsFrom } from "@/lib/data/mappers";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, notFound } from "@/lib/errors";
import type { CalendarDate, Cents } from "@/lib/types";
import type { GoalCreateInput, GoalUpdateInput } from "@/lib/validation/goals";

/**
 * The write half of the goals DAL.
 *
 * ## The rules this module keeps, unchanged from CP2–CP5
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()`
 * and uses what it returns. **Every statement carries an explicit owner
 * predicate** on top of RLS (`goals_insert_own`/`goals_update_own` are the
 * enforced floor). **No navigation, no revalidation.** **Errors are typed,
 * never raw.**
 *
 * ## Idempotency
 *
 * `goals` carries no unique constraint beyond its primary key, so a 23505
 * here has exactly one possible cause — same shape as CP2's accounts and
 * categories: the create form mints a client UUID, a retry collides with
 * itself, and this module reads back its own row to tell an exact-match
 * retry apart from an edited resubmission apart from a foreign owner's key.
 *
 * ## No delete function
 *
 * There is no `deleteGoal`, and there will not be one: `goals` holds no
 * DELETE grant. `docs/database-schema.md` §5's rule is soft-delete only —
 * deleting a goal must never silently destroy the contribution history
 * that proves what actually happened to it.
 */

/** The columns a read-back needs to compare a stored row against a payload. */
const OWN_ROW_COLUMNS = "id, user_id, name, target_cents, target_date";

/** One stored goal, normalized for comparison. Never returned to a caller. */
interface StoredGoal {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly targetCents: Cents;
  readonly targetDate?: CalendarDate;
}

/**
 * The owned goal behind `goalId`, or `undefined`.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's goal" and "no such goal" are deliberately
 * indistinguishable to the caller.
 */
async function readOwnGoal(goalId: string): Promise<StoredGoal | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goals")
    .select(OWN_ROW_COLUMNS)
    .eq("id", goalId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the goal");

  const rows = data as {
    id: string;
    user_id: string;
    name: string;
    target_cents: number | string;
    target_date: string | null;
  }[];
  if (rows.length !== 1) return undefined;

  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    targetCents: centsFrom(row.target_cents, "goals.target_cents"),
    targetDate: calendarDateOrUndefined(row.target_date, "goals.target_date"),
  };
}

export interface GoalCreateResult {
  readonly id: string;
  /** True when the row was already there, byte-identical, under the same key. */
  readonly deduplicated: boolean;
}

/** Creates one goal at the caller-supplied idempotency key. See the module note. */
export async function createGoal(input: GoalCreateInput): Promise<GoalCreateResult> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { error } = await supabase.from("goals").insert({
    id: input.id,
    user_id: ownerId,
    name: input.name,
    target_cents: input.targetCents,
    target_date: input.targetDate ?? null,
  });

  if (error === null) return { id: input.id, deduplicated: false };

  const mapped = mapWriteError(error, "the goal");
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnGoal(input.id);
  // Not our key: falls through as the ordinary unique conflict it is.
  if (existing === undefined) throw mapped;

  if (
    existing.name === input.name &&
    existing.targetCents === input.targetCents &&
    (existing.targetDate ?? null) === (input.targetDate ?? null)
  ) {
    return { id: input.id, deduplicated: true };
  }

  throw conflict("A different goal was already saved with that submission.");
}

/**
 * Renames, retargets, and/or re-dates one owned goal.
 *
 * Legal while the goal is archived — editing a goal's own metadata never
 * touches a single contribution row, so there is nothing here for
 * archiving to protect. A target may be edited below the currently saved
 * amount: an over-funded goal is already a supported, displayed state.
 */
export async function updateGoal(input: GoalUpdateInput): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnGoal(input.id);
  if (existing === undefined) throw notFound("That goal does not exist.");

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("goals")
    .update({
      name: input.name,
      target_cents: input.targetCents,
      target_date: input.targetDate ?? null,
    })
    .eq("id", input.id)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the goal");
}

/**
 * Archives or unarchives one owned goal.
 *
 * Unconditional in both directions — unlike an account, nothing about a
 * goal's own state can make archiving unsafe: every contribution is
 * retained regardless (`docs/database-schema.md` §5), and
 * `assert_goal_contribution_refs()` is what actually prevents *new*
 * contributions while archived. There is no auto-archive-on-completion
 * logic anywhere in this path — reaching the target is not itself a reason
 * to stop tracking a goal.
 */
export async function setGoalArchived(goalId: string, archived: boolean): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnGoal(goalId);
  if (existing === undefined) throw notFound("That goal does not exist.");

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("goals")
    // A plain instant, not a calendar-day derivation from the owner's
    // timezone: "when was this archived" is an audit fact about the write
    // itself, not a financial date subject to the posted-ledger rule.
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", goalId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the goal");
}
