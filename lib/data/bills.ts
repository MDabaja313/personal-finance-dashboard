import "server-only";

import { mockBills } from "@/lib/mock";
import type { Bill } from "@/lib/types";

/** Ordering: `due_date ASC, name ASC, id ASC` — see docs/database-schema.md. */
function byDueDate(a: Bill, b: Bill): number {
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

export async function getBills(): Promise<Bill[]> {
  return [...mockBills].sort(byDueDate);
}

/**
 * Soonest due date first — an overdue bill sorts to the top.
 *
 * The contract this establishes is a `LIMIT`-capable query shape, so the
 * Phase 6 SQL implementation can fetch only `limit` rows instead of every
 * bill to display a handful. The mock implementation below still sorts the
 * full (small) fixture array before slicing — it does not itself avoid the
 * scan, only exposes the shape that lets SQL avoid it.
 */
export async function getUpcomingBills(limit: number): Promise<Bill[]> {
  return [...mockBills].sort(byDueDate).slice(0, limit);
}
