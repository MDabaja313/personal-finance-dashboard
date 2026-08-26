import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { Category } from "@/lib/types";

/**
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle. Checkpoint
 * 2 replaces the body with a `categories` read.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getCategories(): Promise<Category[]> {
  return oracle.getCategories();
}
