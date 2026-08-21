import "server-only";

import { mockBills } from "@/lib/mock";
import type { Bill } from "@/lib/types";

export async function getBills(): Promise<Bill[]> {
  return [...mockBills];
}

/** Soonest due date first — an overdue bill sorts to the top. */
export async function getUpcomingBills(limit: number): Promise<Bill[]> {
  return [...mockBills].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, limit);
}
