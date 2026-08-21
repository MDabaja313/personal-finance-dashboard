import "server-only";

import { mockNetWorthHistory } from "@/lib/mock";
import type { NetWorthSnapshot } from "@/lib/types";

/** Most recent `months` snapshots, oldest first. Omit for the full history. */
export async function getNetWorthHistory(months?: number): Promise<NetWorthSnapshot[]> {
  if (months === undefined) return [...mockNetWorthHistory];
  return mockNetWorthHistory.slice(-months);
}
