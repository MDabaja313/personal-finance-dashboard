import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, invalidInput, notFound } from "@/lib/errors";
import type { CalendarDate, Cents } from "@/lib/types";
import type { GoalContributionCreateInput } from "@/lib/validation/goal-contributions";

/**
 * The write half of the goal-contribution DAL — INSERT only, permanently.
 *
 * ## Append-only, and this module is the proof of it
 *
 * There is no `updateGoalContribution` and no `deleteGoalContribution`
 * here, and there will not be: `goal_contributions` holds no UPDATE grant
 * and no DELETE grant at all (`supabase/migrations/20260830120001_budget_goal_writes.sql`).
 * A correction or a withdrawal is `createGoalContribution` called again
 * with a negative or offsetting amount — a new signed row, never a rewrite
 * of an old one. That is what makes `Goal.savedCents` (the `goal_balances`
 * rollup) a genuine audit trail rather than a mutable ledger that happens
 * to be summed.
 *
 * ## The rules this module keeps, unchanged from CP2–CP5
 *
 * **The owner is never a parameter.** **Every statement carries an explicit
 * owner predicate** on top of RLS (`goal_contributions_insert_own`).
 * **No navigation, no revalidation.** **Errors are typed, never raw.**
 *
 * ## Why the goal preflight exists
 *
 * `createGoalContribution` reads the target goal before it writes — an
 * error-quality check, not an authorization one:
 * `assert_goal_contribution_refs()` already refuses a contribution to an
 * archived goal, but reaching that as a bare SQLSTATE 23514 says nothing
 * about what to do next. The database guard is not thereby redundant: this
 * preflight is genuinely racy (the goal can be archived between the read
 * and the write, which is exactly the window the trigger closes) and must
 * never be relied on alone.
 *
 * ## Idempotency
 *
 * Same shape as CP2's accounts/categories and CP6's goals: no second
 * unique constraint on this table, so a 23505 has exactly one cause — the
 * client-minted id colliding with itself on retry, or with another owner's
 * (RLS-hidden) row. Never inferred from amount/date/note alone: two
 * identical real contributions are legitimate distinct events.
 */

/** The columns a read-back needs to compare a stored row against a payload. */
const OWN_ROW_COLUMNS = "id, user_id, goal_id, amount_cents, occurred_on, note";

/** One stored contribution, normalized for comparison. Never returned to a caller. */
interface StoredContribution {
  readonly id: string;
  readonly userId: string;
  readonly goalId: string;
  readonly amountCents: Cents;
  readonly occurredOn: CalendarDate;
  readonly note?: string;
}

/**
 * The owned contribution behind `contributionId`, or `undefined`.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's contribution" and "no such contribution" are
 * deliberately indistinguishable to the caller.
 */
async function readOwnContribution(contributionId: string): Promise<StoredContribution | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goal_contributions")
    .select(OWN_ROW_COLUMNS)
    .eq("id", contributionId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the contribution");

  const rows = data as {
    id: string;
    user_id: string;
    goal_id: string;
    amount_cents: number | string;
    occurred_on: string;
    note: string | null;
  }[];
  if (rows.length !== 1) return undefined;

  const row = rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    goalId: row.goal_id,
    amountCents: centsFrom(row.amount_cents, "goal_contributions.amount_cents"),
    occurredOn: row.occurred_on,
    note: row.note ?? undefined,
  };
}

/**
 * Refuses a goal that does not exist, is not the caller's, or is archived —
 * the message layer in front of `assert_goal_contribution_refs()`.
 */
async function assertGoalUsableForContribution(goalId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goals")
    .select("archived_at")
    .eq("id", goalId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the contribution");

  const rows = data as { archived_at: string | null }[];
  if (rows.length !== 1) throw notFound("That goal does not exist.");
  if (rows[0].archived_at !== null) {
    throw invalidInput("This goal is archived. Unarchive it before adding a contribution.");
  }
}

export interface GoalContributionCreateResult {
  readonly id: string;
  /** True when the row was already there, byte-identical, under the same key. */
  readonly deduplicated: boolean;
}

/** Creates one contribution at the caller-supplied idempotency key. See the module note. */
export async function createGoalContribution(
  input: GoalContributionCreateInput
): Promise<GoalContributionCreateResult> {
  const ownerId = await getOwnerId();
  await assertGoalUsableForContribution(input.goalId);

  const supabase = await getDataClient();

  const { error } = await supabase.from("goal_contributions").insert({
    id: input.id,
    user_id: ownerId,
    goal_id: input.goalId,
    amount_cents: input.amountCents,
    occurred_on: input.occurredOn,
    note: input.note ?? null,
  });

  if (error === null) return { id: input.id, deduplicated: false };

  const mapped = mapWriteError(error, "the contribution");
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnContribution(input.id);
  // Not our key: falls through as the ordinary unique conflict it is.
  if (existing === undefined) throw mapped;

  if (
    existing.goalId === input.goalId &&
    existing.amountCents === input.amountCents &&
    existing.occurredOn === input.occurredOn &&
    (existing.note ?? null) === (input.note ?? null)
  ) {
    return { id: input.id, deduplicated: true };
  }

  throw conflict("A different contribution was already saved with that submission.");
}
