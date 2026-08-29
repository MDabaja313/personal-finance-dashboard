"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import type { ActionState } from "@/lib/actions/types";
import { createGoal, setGoalArchived, updateGoal } from "@/lib/data/mutations/goals";
import { goalArchiveSchema, goalCreateSchema, goalUpdateSchema } from "@/lib/validation/goals";

/**
 * Goal Server Actions — the same four steps as every other write in this
 * application: validate, `attempt()` the mutation, redirect or return a safe
 * `ActionState`, then revalidate precisely.
 *
 * No `getToday()` here: a goal itself carries no date that needs the
 * owner's calendar day — `targetDate` is an optional, unconstrained
 * calendar date, not a posted-ledger fact. Contributions are the operation
 * that needs `today`, and they live in `lib/actions/goal-contributions.ts`.
 *
 * Where authentication happens: not here. Every function in
 * `lib/data/mutations/goals.ts` calls `getOwnerId()`, which throws
 * `unauthorized` without verified claims; this layer only turns that into
 * `redirect("/login")`.
 */

/**
 * A goal only ever renders on `/goals` and in the dashboard's goal-progress
 * section — never on `/accounts`, `/transactions`, or `/analytics`, since a
 * goal moves no balance and creates no transaction.
 */
const GOAL_ROUTES = ["/goals", "/dashboard"] as const;

function revalidateGoalRoutes(): void {
  for (const route of GOAL_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const GOAL_FORM_FIELDS = ["name", "target", "targetDate"] as const;

/**
 * `goals` carries no unique constraint beyond its primary key, so on this
 * operation `conflict` can only mean the idempotency key: either an edited
 * resubmission under a stale key, or a key belonging to another owner. One
 * message covers both, the same way `DUPLICATE_SUBMISSION` does for
 * ordinary transactions.
 */
const GOAL_CONFLICT =
  "A different goal was already saved with that submission. Refresh the page and try again.";

export async function createGoalAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, GOAL_FORM_FIELDS);

  const parsed = goalCreateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    target: formData.get("target"),
    targetDate: formData.get("targetDate"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createGoal(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(GOAL_CONFLICT, values);
    return outcome.state;
  }

  revalidateGoalRoutes();

  // Deliberately indistinguishable from a first-time create — an exact
  // retry accomplished what the person asked for.
  return succeeded();
}

export async function updateGoalAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, GOAL_FORM_FIELDS);

  const parsed = goalUpdateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    target: formData.get("target"),
    targetDate: formData.get("targetDate"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateGoal(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateGoalRoutes();
  return succeeded();
}

export async function setGoalArchivedAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = goalArchiveSchema.safeParse({
    id: formData.get("id"),
    archived: formData.get("archived"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => setGoalArchived(parsed.data.id, parsed.data.archived));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateGoalRoutes();
  return succeeded();
}
