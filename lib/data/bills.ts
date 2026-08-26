import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { Bill } from "@/lib/types";

/**
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 3 replaces these bodies with the two-query next-scheduled-occurrence
 * projection over `bills` + `bill_occurrences` — `Bill.dueDate` is not a
 * stored column.
 *
 * Ordering: `due_date ASC, name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getBills(): Promise<Bill[]> {
  return oracle.getBills();
}

/**
 * Soonest due date first — an overdue bill sorts to the top. Deliberately
 * applies no `today` filter.
 *
 * The contract this establishes is a `LIMIT`-capable query shape, so the
 * Supabase implementation can stop after `limit` bills instead of materializing
 * every one to display a handful.
 */
export async function getUpcomingBills(limit: number): Promise<Bill[]> {
  return oracle.getUpcomingBills(limit);
}
