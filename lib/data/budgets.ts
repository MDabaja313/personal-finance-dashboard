import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toBudget } from "@/lib/data/mappers";
import type { BudgetRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Budget, MonthKey } from "@/lib/types";

/**
 * Phase 6 Checkpoint 2: reads `public.budgets`, filtered to the requested
 * period.
 *
 * Ordering: `category_id ASC, id ASC` — a deterministic *technical* order
 * only, not a display order (this DAL has no join to `categories`, so it
 * cannot order by category name). Callers that render a budget list must
 * apply their own semantic display order using category names they already
 * fetch — see the `/budgets` page and the Dashboard's budget section.
 */
export async function getBudgets(period: MonthKey): Promise<Budget[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("budgets")
    .select("id, category_id, period, limit_cents")
    .eq("user_id", ownerId)
    .eq("period", period)
    .order("category_id", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "budgets");

  return (data as BudgetRow[]).map(toBudget);
}
