import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toCategory } from "@/lib/data/mappers";
import type { CategoryRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Category } from "@/lib/types";

/**
 * Reads `public.categories`. Archived rows are returned deliberately: this
 * list resolves category *names* for historical transactions, and filtering
 * them out would blank those labels.
 *
 * Phase 7 CP2 added `is_archived` to both the selected columns and the DTO.
 * The read semantics are otherwise unchanged — nothing is newly filtered —
 * the flag is simply visible now, so the category management surface can show
 * archive state and a future new-entry picker can hide archived options.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getCategories(): Promise<Category[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, is_archived")
    .eq("user_id", ownerId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "categories");

  return (data as CategoryRow[]).map(toCategory);
}
