import "server-only";

import { mockNetWorthHistory } from "@/lib/mock";
import type { NetWorthSnapshot } from "@/lib/types";

/**
 * Most recent `months` snapshots, oldest first. Omit for the full history.
 *
 * Ordering: `month ASC` — `month` is the primary key, so this is fully
 * deterministic with no further tie-break needed. When `months` is given,
 * the *most recent* N snapshots are selected, but the returned list stays
 * chronological (ASC) — charts depend on chronological order.
 */
export async function getNetWorthHistory(months?: number): Promise<NetWorthSnapshot[]> {
  const sorted = [...mockNetWorthHistory].sort((a, b) => a.month.localeCompare(b.month));
  if (months === undefined) return sorted;
  return sorted.slice(-months);
}
