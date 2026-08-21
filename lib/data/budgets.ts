import "server-only";

import { mockBudgets } from "@/lib/mock";
import type { Budget, MonthKey } from "@/lib/types";

export async function getBudgets(period: MonthKey): Promise<Budget[]> {
  return mockBudgets.filter((budget) => budget.period === period);
}
