import "server-only";

import { mockBudgets } from "@/lib/mock";
import type { Budget, MonthKey } from "@/lib/types";

/**
 * Ordering: `category_id ASC, id ASC` — a deterministic *technical* order
 * only, not a display order (this DAL has no join to `categories`, so it
 * cannot order by category name). Callers that render a budget list must
 * apply their own semantic display order using category names they already
 * fetch — see the `/budgets` page and the Dashboard's budget section.
 */
export async function getBudgets(period: MonthKey): Promise<Budget[]> {
  return mockBudgets
    .filter((budget) => budget.period === period)
    .slice()
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.id.localeCompare(b.id));
}
