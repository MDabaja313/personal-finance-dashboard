"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import type { ActionState } from "@/lib/actions/types";
import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "@/lib/data/mutations/categories";
import {
  categoryArchiveSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
} from "@/lib/validation/categories";

/**
 * Category Server Actions — the same four steps, in the same order, as
 * `lib/actions/accounts.ts`: validate, `attempt()` the mutation, redirect or
 * return a safe state, then revalidate precisely.
 *
 * Authentication is likewise not performed here. Every function in
 * `lib/data/mutations/categories.ts` calls `getOwnerId()` and throws
 * `unauthorized` without verified claims; this layer only decides that an ended
 * session becomes `redirect("/login")` rather than a message a form cannot act
 * on. `redirect()` runs after `attempt()` has returned, never inside it.
 *
 * No `getToday()`: a category carries no date.
 */

/**
 * The routes a category write changes.
 *
 * `/transactions` renders category names on every row and offers them as a
 * filter; `/budgets` labels every budget by its category; the dashboard renders
 * spending-by-category and the budget section; analytics renders the category
 * spending bars. `/accounts` and `/bills` do not resolve category names, so
 * they are deliberately absent — and `revalidatePath("/")` would discard every
 * cached route to refresh four.
 *
 * `/settings`, which hosts the management surface itself, is deliberately not
 * in this list and does not need to be: calling `revalidatePath` at all makes
 * Next.js re-render the *current* route server-side and return the new RSC
 * payload in the same roundtrip, so the list a person is editing refreshes on
 * its own (node_modules/next/dist/docs/01-app/02-guides/server-actions.md).
 */
const CATEGORY_ROUTES = ["/transactions", "/budgets", "/dashboard", "/analytics"] as const;

function revalidateCategoryRoutes(): void {
  for (const route of CATEGORY_ROUTES) revalidatePath(route);
}

const CATEGORY_FORM_FIELDS = ["name", "kind"] as const;

/**
 * Fixed, developer-authored messages for the two failures a person can act on.
 *
 * The mapping is what makes them safe to be specific: on a category write
 * `conflict` can only be the case-insensitive unique index on
 * `(user_id, lower(name))` — the one unique constraint this table has — while
 * `invalid_input` can only be the kind rule, arriving either from the mutation
 * layer's preflight or from `guard_category_kind_change()` as a check
 * violation. The form input itself was already validated to a name and a known
 * kind, so it cannot be the source of either. Neither message is derived from
 * an `AppError`; both are constants.
 */
const DUPLICATE_NAME = "You already have a category with that name.";
const KIND_LOCKED = "This category is already in use, so its type can no longer be changed.";

export async function createCategoryAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, CATEGORY_FORM_FIELDS);

  const parsed = categoryCreateSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createCategory(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(DUPLICATE_NAME, values);
    return outcome.state;
  }

  revalidateCategoryRoutes();
  return succeeded();
}

export async function updateCategoryAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, CATEGORY_FORM_FIELDS);

  const parsed = categoryUpdateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    kind: formData.get("kind"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateCategory(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(DUPLICATE_NAME, values);
    if (outcome.reason === "invalid_input") return failed(KIND_LOCKED, values);
    return outcome.state;
  }

  revalidateCategoryRoutes();
  return succeeded();
}

export async function setCategoryArchivedAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = categoryArchiveSchema.safeParse({
    id: formData.get("id"),
    archived: formData.get("archived"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() =>
    setCategoryArchived(parsed.data.id, parsed.data.archived)
  );

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateCategoryRoutes();
  return succeeded();
}
