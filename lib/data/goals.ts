import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { Goal } from "@/lib/types";

/**
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 2 replaces the body with a `goal_balances` view read.
 *
 * Ordering: `target_date ASC NULLS LAST, name ASC, id ASC` — see
 * docs/database-schema.md. A goal with no target date sorts after every
 * goal that has one.
 */
export async function getGoals(): Promise<Goal[]> {
  return oracle.getGoals();
}
