import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { NetWorthSnapshot } from "@/lib/types";

/**
 * Most recent `months` snapshots, oldest first. Omit for the full history.
 *
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 2 replaces the body with a `net_worth_snapshots` read.
 *
 * Ordering: `month ASC` — `month` is part of the primary key, so this is fully
 * deterministic with no further tie-break needed. When `months` is given, the
 * *most recent* N snapshots are selected, but the returned list stays
 * chronological (ASC) — charts depend on chronological order. `months === 0`
 * returns the full history, not an empty list (see the oracle).
 */
export async function getNetWorthHistory(months?: number): Promise<NetWorthSnapshot[]> {
  return oracle.getNetWorthHistory(months);
}
