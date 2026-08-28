/**
 * Category form input → validated domain values.
 *
 * The smallest schema in this layer, and deliberately so: a category is a name
 * and a kind. Everything else about it — whether the kind may still change,
 * whether the name collides with an existing one — depends on data this layer
 * is not allowed to read, and is settled by the database
 * (`guard_category_kind_change()`, the unique index on
 * `(user_id, lower(name))`) with a mutation-layer preflight in front of it for
 * a better message.
 *
 * As in `lib/validation/accounts.ts`: **no owner id is accepted from the
 * caller**. The owner comes from `getOwnerId()` inside the mutation DAL,
 * verified from the request's own claims.
 *
 * `zName` trims before checking emptiness and outputs the trimmed value, which
 * matters more here than anywhere else in the app: the uniqueness index is on
 * `lower(name)`, so an untrimmed " Groceries" would slip past a collision with
 * "Groceries" and produce two categories a person cannot tell apart.
 */
import { z } from "zod";

import type { Category } from "@/lib/types";
import { CATEGORY_KINDS } from "@/lib/types/enums";
import { zName, zUuid } from "@/lib/validation/primitives";

type CategoryKind = Category["kind"];

/** `public.category_kind`, narrowed from the single canonical label list. */
export const zCategoryKind: z.ZodType<CategoryKind, string> = z
  .string({ error: "Select a type." })
  .refine((value): value is CategoryKind => (CATEGORY_KINDS as readonly string[]).includes(value), {
    error: "Select a type.",
  });

export interface CategoryCreateInput {
  readonly name: string;
  readonly kind: CategoryKind;
}

export const categoryCreateSchema = z.object({
  name: zName,
  kind: zCategoryKind,
});

export interface CategoryUpdateInput {
  readonly id: string;
  readonly name: string;
  readonly kind: CategoryKind;
}

/**
 * Rename and/or retype.
 *
 * `kind` is always submitted, even when it is unchanged — the mutation layer
 * compares it against the stored value and only treats it as a *change* when
 * it actually differs, which is what keeps renaming a referenced category
 * working. A schema that made `kind` conditional would have to know whether the
 * category is referenced, which is exactly the database read this layer must
 * not perform.
 */
export const categoryUpdateSchema = z.object({
  id: zUuid,
  name: zName,
  kind: zCategoryKind,
});

/**
 * Archive/unarchive. Same string-literal comparison as the account version, for
 * the same reason: `Boolean("false")` is `true`, and a coercion bug here would
 * silently invert an archive.
 */
export const categoryArchiveSchema = z.object({
  id: zUuid,
  archived: z
    .string({ error: "Select a state." })
    .refine((value) => value === "true" || value === "false", { error: "Select a state." })
    .transform((value) => value === "true"),
});
