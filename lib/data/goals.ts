import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toGoal } from "@/lib/data/mappers";
import type { GoalBalanceRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Goal } from "@/lib/types";

/**
 * Phase 6 Checkpoint 2: reads `public.goal_balances`, the `security_invoker`
 * view whose `saved_cents` is derived from `goal_contributions`. Filtered to
 * `archived_at IS NULL` — an archived goal is not on the `Goal` DTO's
 * contract and is excluded entirely, unlike an archived account or category.
 *
 * Ordering: `target_date ASC NULLS LAST, name ASC, id ASC` — see
 * docs/database-schema.md. A goal with no target date sorts after every
 * goal that has one.
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
