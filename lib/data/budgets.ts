import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { Budget, MonthKey } from "@/lib/types";

/**
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 2 replaces the body with a `budgets` read.
 *
 * Ordering: `category_id ASC, id ASC` — a deterministic *technical* order
 * only, not a display order (this DAL has no join to `categories`, so it
 * cannot order by category name). Callers that render a budget list must
 * apply their own semantic display order using category names they already
 * fetch — see the `/budgets` page and the Dashboard's budget section.
 */
export async function getBudgets(period: MonthKey): Promise<Budget[]> {
  return oracle.getBudgets(period);
}
