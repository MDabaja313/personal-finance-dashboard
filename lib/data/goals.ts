import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { calendarDateFrom, centsFrom, toGoal } from "@/lib/data/mappers";
import type { GoalBalanceManagementRow, GoalBalanceRow, GoalContributionRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { CalendarDate, Cents, Goal } from "@/lib/types";

/**
 * Phase 6 Checkpoint 2: reads `public.goal_balances`, the `security_invoker`
 * view whose `saved_cents` is derived from `goal_contributions`. Filtered to
 * `archived_at IS NULL` — an archived goal is not on the `Goal` DTO's
 * contract and is excluded entirely, unlike an archived account or category.
 *
 * Ordering: `target_date ASC NULLS LAST, name ASC, id ASC` — see
 * docs/database-schema.md. A goal with no target date sorts after every
 * goal that has one.
 *
 * **This contract is unchanged by Phase 7 CP6** — the dashboard depends on
 * it returning active goals only. `getGoalsForManagement()`, below, is the
 * narrow addition CP6 needed: a management view that can also show archived
 * goals, for unarchiving.
 */
export async function getGoals(): Promise<Goal[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goal_balances")
    .select("id, name, target_cents, target_date, saved_cents")
    .eq("user_id", ownerId)
    .is("archived_at", null)
    .order("target_date", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "goals");

  return (data as GoalBalanceRow[]).map(toGoal);
}

/**
 * A `Goal` widened with archive state — Phase 7 CP6's one addition to the
 * read side, for `/goals`' management view. Colocated here rather than on
 * the shared `Goal` DTO in `lib/types/index.ts`, the same way `Movement`
 * lives in `lib/data/movements.ts`: nothing outside the management surface
 * needs to know a goal's archive state.
 */
export interface GoalManagement extends Goal {
  readonly isArchived: boolean;
}

function toGoalManagement(row: GoalBalanceManagementRow): GoalManagement {
  return { ...toGoal(row), isArchived: row.archived_at !== null };
}

/**
 * Every owned goal, active and archived alike — the one place archive state
 * is exposed, so `/goals` can render an "Unarchive" control. `getGoals()`
 * keeps its narrower, active-only contract because the dashboard depends on
 * it; nothing here changes that function's query or its result.
 *
 * Ordering matches `getGoals()`'s: `target_date ASC NULLS LAST, name ASC,
 * id ASC`. The page groups the result into active/archived sections itself
 * (the same split `/accounts` already does for archived accounts), so a
 * single semantic order underneath both groups is enough.
 */
export async function getGoalsForManagement(): Promise<GoalManagement[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goal_balances")
    .select("id, name, target_cents, target_date, saved_cents, archived_at")
    .eq("user_id", ownerId)
    .order("target_date", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "goals");

  return (data as GoalBalanceManagementRow[]).map(toGoalManagement);
}

/**
 * One goal contribution, as contribution history displays it. `note` is
 * legitimately absent; the signed `amountCents` is exactly what
 * `goal_balances.saved_cents` sums.
 */
export interface GoalContribution {
  readonly id: string;
  readonly amountCents: Cents;
  readonly occurredOn: CalendarDate;
  readonly note?: string;
}

function toGoalContribution(row: GoalContributionRow): GoalContribution {
  return {
    id: row.id,
    amountCents: centsFrom(row.amount_cents, "goal_contributions.amount_cents"),
    occurredOn: calendarDateFrom(row.occurred_on, "goal_contributions.occurred_on"),
    note: row.note ?? undefined,
  };
}

/**
 * One goal's full contribution history, newest first — Phase 7 CP6's
 * read-side counterpart to the append-only write path.
 *
 * Ordering: `occurred_on DESC, created_at DESC, id ASC`, the same shape as
 * `getTransactions()`'s contract (docs/database-schema.md §17) and for the
 * identical reason — `created_at` is selected purely as the same-day
 * entry-recency tie-break and is never on the DTO.
 *
 * Remains available after the goal is archived: archiving a goal never
 * hides its history, only prevents new contributions
 * (`assert_goal_contribution_refs()`). An id naming no visible goal (a
 * foreign or deleted one) simply returns `[]` — the owner predicate is
 * enough to make that safe, with no separate existence check needed for a
 * read.
 */
export async function getGoalContributions(goalId: string): Promise<GoalContribution[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("goal_contributions")
    .select("id, goal_id, amount_cents, occurred_on, note")
    .eq("goal_id", goalId)
    .eq("user_id", ownerId)
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "goal contributions");

  return (data as GoalContributionRow[]).map(toGoalContribution);
}
