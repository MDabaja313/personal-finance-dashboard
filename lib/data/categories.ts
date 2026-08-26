import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toCategory } from "@/lib/data/mappers";
import type { CategoryRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Category } from "@/lib/types";

/**
 * Phase 6 Checkpoint 2: reads `public.categories`. `is_archived` is not
 * selected — it never appears on the `Category` DTO — but archived rows are
 * still returned: this list resolves category *names* for historical
 * transactions, and filtering archived rows out would blank those labels.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getCategories(): Promise<Category[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind")
    .eq("user_id", ownerId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "categories");

  return (data as CategoryRow[]).map(toCategory);
}
