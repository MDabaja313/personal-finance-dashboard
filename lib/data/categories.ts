import "server-only";

import { mockCategories } from "@/lib/mock";
import type { Category } from "@/lib/types";

/** Ordering: `name ASC, id ASC` — see docs/database-schema.md. */
export async function getCategories(): Promise<Category[]> {
  return [...mockCategories].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}
