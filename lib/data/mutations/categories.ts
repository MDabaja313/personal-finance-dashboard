import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { invalidInput, notFound } from "@/lib/errors";
import type { Category } from "@/lib/types";
import type { CategoryCreateInput, CategoryUpdateInput } from "@/lib/validation/categories";

/**
 * The write half of the categories DAL.
 *
 * Same contract as `lib/data/mutations/accounts.ts`, and for the same reasons:
 * the owner is never a parameter (`getOwnerId()` re-establishes it from the
 * request's verified claims on every write), every statement carries an
 * explicit owner predicate on top of RLS, nothing here navigates or
 * revalidates, and every failed response goes through `mapWriteError` so no
 * PostgREST message is ever quoted onward.
 *
 * ## The kind rule
 *
 * A category's `kind` decides whether its transactions count as income or as
 * spending, in every rollup the application has. Changing it on a category that
 * already has history does not correct a mistake — it silently reclassifies
 * months of settled figures, and every chart already read from them. So the
 * kind is editable only while the category is completely unreferenced.
 *
 * That rule is a database invariant (`guard_category_kind_change()`), because
 * `authenticated` now holds a direct UPDATE (kind) privilege on this table and
 * PostgREST is reachable from a browser. The preflight below is the message
 * layer in front of it, not a replacement for it.
 */

/** What a preflight needs to know about an existing category. */
interface CategoryWriteContext {
  readonly kind: Category["kind"];
  readonly isArchived: boolean;
}

/**
 * The owned category behind `categoryId`, or `not_found`.
 *
 * A foreign or deleted id produces zero rows through RLS either way, so
 * "someone else's category" and "no such category" are deliberately
 * indistinguishable to the caller.
 */
async function readCategoryContext(categoryId: string): Promise<CategoryWriteContext> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("kind, is_archived")
    .eq("id", categoryId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the category");

  const rows = data as { kind: string; is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That category does not exist.");

  return { kind: rows[0].kind as Category["kind"], isArchived: rows[0].is_archived };
}

/**
 * Creates a category and returns its id.
 *
 * A duplicate name surfaces as SQLSTATE 23505 from the case-insensitive unique
 * index on `(user_id, lower(name))` and is classified `conflict` by
 * `mapWriteError` — the input was well formed, it just collides, so the remedy
 * is a different value rather than a corrected one. `is_archived` is not in the
 * CP2 INSERT grant and is not set; `id` takes its default.
 */
export async function createCategory(input: CategoryCreateInput): Promise<string> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .insert({ user_id: ownerId, name: input.name, kind: input.kind })
    .select("id")
    .single();

  if (error) throw mapWriteError(error, "the category");

  const row = data as { id: string } | null;
  if (!row) throw mapWriteError(new Error("insert returned no row"), "the category");

  return row.id;
}

/**
 * Renames and/or retypes one owned category.
 *
 * `kind` is always in the payload, but only counts as a *change* when it
 * differs from the stored value — which is what keeps renaming a referenced
 * category working. When it does differ, the preflight refuses if anything
 * references the category, matching `guard_category_kind_change()`.
 *
 * Classified `invalid_input` rather than `conflict`, and that split is load
 * bearing at the action layer: on this operation `conflict` can only mean the
 * unique-name index, so the two situations stay tellable apart without reading
 * a driver error.
 */
export async function updateCategory(input: CategoryUpdateInput): Promise<void> {
  const ownerId = await getOwnerId();
  const context = await readCategoryContext(input.id);

  if (input.kind !== context.kind && (await isCategoryReferenced(input.id))) {
    throw invalidInput("This category is already in use, so its type can no longer be changed.");
  }

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("categories")
    .update({ name: input.name, kind: input.kind })
    .eq("id", input.id)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the category");
}

/**
 * Archives or unarchives one owned category.
 *
 * Unconditional in both directions, unlike an account: an archived category is
 * still returned by `getCategories()` and still resolves the label on every
 * historical row that references it — archiving only keeps it out of future
 * entry. Nothing can be lost by it, so there is nothing to guard.
 */
export async function setCategoryArchived(categoryId: string, archived: boolean): Promise<void> {
  const ownerId = await getOwnerId();

  // Read first purely so a deleted or foreign id fails as `not_found` rather
  // than as a silent no-op — an UPDATE matching zero rows is not an error.
  await readCategoryContext(categoryId);

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("categories")
    .update({ is_archived: archived })
    .eq("id", categoryId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the category");
}

/**
 * Whether anything at all points at the owned category.
 *
 * The three columns checked are every reference to a category in this schema:
 * `transactions.category_id`, `budgets.category_id`, `bills.category_id` —
 * the same three `guard_category_kind_change()` checks, kept in step
 * deliberately, since a fourth referencing column added to only one of the two
 * would let a reclassification through the layer a person actually hits.
 *
 * `head: true` with an exact count asks PostgREST for a count and no rows. The
 * three probes run concurrently — they are independent, and an unreferenced
 * category is exactly the case where all three have to be asked.
 *
 * Each relation is named as a literal rather than looped over a table list, so
 * `lib/write-posture.test.ts` can enumerate every relation this layer touches
 * by scanning the source. A dynamic `.from(table)` would read a little shorter
 * and would make that check silently incomplete.
 */
async function isCategoryReferenced(categoryId: string): Promise<boolean> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const results = await Promise.all([
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("category_id", categoryId)
      .eq("user_id", ownerId),
    supabase
      .from("budgets")
      .select("id", { count: "exact", head: true })
      .eq("category_id", categoryId)
      .eq("user_id", ownerId),
    supabase
      .from("bills")
      .select("id", { count: "exact", head: true })
      .eq("category_id", categoryId)
      .eq("user_id", ownerId),
  ]);

  for (const { count, error } of results) {
    if (error) throw mapWriteError(error, "the category");
    if ((count ?? 0) > 0) return true;
  }

  return false;
}
