import "server-only";

import { mockGoals } from "@/lib/mock";
import type { Goal } from "@/lib/types";

/**
 * Ordering: `target_date ASC NULLS LAST, name ASC, id ASC` — see
 * docs/database-schema.md. A goal with no target date sorts after every
 * goal that has one.
 */
export async function getGoals(): Promise<Goal[]> {
  return [...mockGoals].sort((a, b) => {
    if (a.targetDate === undefined && b.targetDate === undefined) {
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    }
    if (a.targetDate === undefined) return 1;
    if (b.targetDate === undefined) return -1;
    return (
      a.targetDate.localeCompare(b.targetDate) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
    );
  });
}
