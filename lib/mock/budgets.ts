import { toCents, type Budget } from "@/lib/types";

/**
 * August 2026 budgets. Against mockTransactions this deliberately produces:
 * Dining over budget, Housing near its limit, Shopping net-negative (the Aug
 * refund outweighs the one Aug purchase in that category), and several
 * categories comfortably under.
 */
export const mockBudgets: readonly Budget[] = Object.freeze([
  { id: "bud-2026-08-housing", categoryId: "cat-housing", period: "2026-08", limitCents: toCents(220000) },
  { id: "bud-2026-08-groceries", categoryId: "cat-groceries", period: "2026-08", limitCents: toCents(60000) },
  { id: "bud-2026-08-dining", categoryId: "cat-dining", period: "2026-08", limitCents: toCents(25000) },
  { id: "bud-2026-08-transportation", categoryId: "cat-transportation", period: "2026-08", limitCents: toCents(15000) },
  { id: "bud-2026-08-entertainment", categoryId: "cat-entertainment", period: "2026-08", limitCents: toCents(10000) },
  { id: "bud-2026-08-shopping", categoryId: "cat-shopping", period: "2026-08", limitCents: toCents(20000) },
  { id: "bud-2026-08-utilities", categoryId: "cat-utilities", period: "2026-08", limitCents: toCents(30000) },
  { id: "bud-2026-08-subscriptions", categoryId: "cat-subscriptions", period: "2026-08", limitCents: toCents(5000) },
]);
