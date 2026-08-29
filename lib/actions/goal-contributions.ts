"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import { createGoalContribution } from "@/lib/data/mutations/goal-contributions";
import { makeGoalContributionCreateSchema } from "@/lib/validation/goal-contributions";

/**
 * Goal contribution Server Actions.
 *
 * One action, because contributions are append-only: there is no update or
 * delete surface to give an action to, by design (`lib/data/mutations/goal-contributions.ts`).
 * A correction or a withdrawal is this same action, called again with the
 * "Withdraw / correction" option and a new amount — never an edit to a
 * previous submission.
 *
 * `resolveToday()` is required here, unlike `lib/actions/goals.ts`: a
 * contribution's `occurredOn` is a posted fact, ceilinged at the owner's own
 * calendar day, exactly like an ordinary transaction's date.
 *
 * Where authentication happens: not here. `createGoalContribution` calls
 * `getOwnerId()`, which throws `unauthorized` without verified claims; this
 * layer only turns that into `redirect("/login")`.
 */

/** A contribution changes a goal's saved amount, which renders in the same two places a goal does. */
const CONTRIBUTION_ROUTES = ["/goals", "/dashboard"] as const;

function revalidateContributionRoutes(): void {
  for (const route of CONTRIBUTION_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const CONTRIBUTION_FORM_FIELDS = ["action", "amount", "occurredOn", "note"] as const;

/**
 * Fixed, developer-authored messages for the failures a person can act on.
 *
 * `goal_contributions` carries no unique constraint beyond its primary key,
 * so `conflict` here can only mean the idempotency key — the same single
 * message CP2–CP5 use for that case throughout this application.
 */
const CONTRIBUTION_CONFLICT =
  "A different contribution was already saved with that submission. Refresh the page and try again.";
const ARCHIVED_GOAL = "This goal is archived. Unarchive it before adding a contribution.";

export async function createGoalContributionAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, CONTRIBUTION_FORM_FIELDS);

  const goalId = formData.get("goalId");
  if (typeof goalId !== "string" || goalId === "") {
    return failed("That item no longer exists.", values);
  }

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeGoalContributionCreateSchema(today.today).safeParse({
    id: formData.get("id"),
    goalId,
    action: formData.get("action"),
    amount: formData.get("amount"),
    occurredOn: formData.get("occurredOn"),
    note: formData.get("note"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createGoalContribution(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(CONTRIBUTION_CONFLICT, values);
    if (outcome.reason === "invalid_input") return failed(ARCHIVED_GOAL, values);
    return outcome.state;
  }

  revalidateContributionRoutes();

  // Deliberately indistinguishable from a first-time create — an exact
  // retry accomplished what the person asked for.
  return succeeded();
}
