import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { CalendarDate } from "@/lib/types";

/**
 * Returns a fixed date so bill statuses, "this month" totals, and budget
 * periods stay coherent against the fixture window.
 *
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 4 replaces the body with the real clock, resolved through the owner's
 * `profiles.timezone` — the signature (and every caller) stays the same.
 * Nothing else in the codebase reads the date.
 */
export async function getToday(): Promise<CalendarDate> {
  return oracle.getToday();
}
