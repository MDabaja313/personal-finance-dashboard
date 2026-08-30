"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import { createBudget, deleteBudget, updateBudget } from "@/lib/data/mutations/budgets";
import { monthKey } from "@/lib/finance/dates";
import { budgetDeleteSchema, budgetUpdateSchema, makeBudgetCreateSchema } from "@/lib/validation/budgets";

/**
 * Budget Server Actions — the same four steps as every other write in this
 * application: validate, `attempt()` the mutation, redirect or return a safe
 * `ActionState`, then revalidate precisely.
 *
 * ## The current month comes from the server, never the client
 *
 * The application only ever manages the owner's *current* budgets, so
 * `createBudgetAction` resolves the owner's own calendar day
 * (`resolveToday()`, from `profiles.timezone`) and derives the period from
 * it — a period is never read out of `FormData`. A hand-crafted request
 * naming a different month has nothing to submit that this schema will
 * accept.
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/budgets.ts` calls
 * `getOwnerId()`, which throws `unauthorized` without verified claims; this
 * layer only turns that into `redirect("/login")` rather than a message a
 * form cannot act on.
 */

/**
 * Budgets are planning metadata that only ever renders on `/budgets` and in
 * the dashboard's budget section — never on `/accounts`, `/transactions`, or
 * `/analytics`, since a budget row itself carries no balance, no ledger
 * entry, and no chart data of its own.
 */
const BUDGET_ROUTES = ["/budgets", "/dashboard"] as const;

function revalidateBudgetRoutes(): void {
  for (const route of BUDGET_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const BUDGET_FORM_FIELDS = ["categoryId", "limit"] as const;

/**
 * Fixed, developer-authored messages for the failures a person can act on.
 *
 * `BUDGET_CONFLICT` covers every `conflict` this operation can produce: an
 * exact-match retry never reaches this branch (it reports success), so what
 * remains is either an edited resubmission under a stale key or a genuine
 * second budget for the same category and month — both are "refresh and try
 * again", not something a corrected field would fix.
 */
const BUDGET_CONFLICT =
  "A budget already exists for this category this month, or this was already saved. Refresh the page and try again.";
const CATEGORY_UNUSABLE = "That category can no longer be budgeted. Refresh the page and try again.";

export async function createBudgetAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, BUDGET_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeBudgetCreateSchema(monthKey(today.today)).safeParse({
    id: formData.get("id"),
    categoryId: formData.get("categoryId"),
    limit: formData.get("limit"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createBudget(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(BUDGET_CONFLICT, values);
    if (outcome.reason === "invalid_input") return failed(CATEGORY_UNUSABLE, values);
    return outcome.state;
  }

  revalidateBudgetRoutes();

  // Deliberately indistinguishable from a first-time create — an exact
  // retry accomplished what the person asked for.
  return succeeded();
}

export async function updateBudgetAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, BUDGET_FORM_FIELDS);

  const parsed = budgetUpdateSchema.safeParse({
    id: formData.get("id"),
    limit: formData.get("limit"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateBudget(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateBudgetRoutes();
  return succeeded();
}

export async function deleteBudgetAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = budgetDeleteSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => deleteBudget(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateBudgetRoutes();
  return succeeded();
}
