import "server-only";

import { MOCK_TODAY } from "@/lib/mock";
import type { CalendarDate } from "@/lib/types";

/**
 * Phase 1: returns a fixed date so bill statuses, "this month" totals, and
 * budget periods stay coherent against the fixture window. Phase 6 swaps
 * this body for the real clock — the signature (and every caller) stays
 * the same. Nothing else in the codebase reads the date.
 */
export async function getToday(): Promise<CalendarDate> {
  return MOCK_TODAY;
}
