import "server-only";

import { mockGoals } from "@/lib/mock";
import type { Goal } from "@/lib/types";

export async function getGoals(): Promise<Goal[]> {
  return [...mockGoals];
}
