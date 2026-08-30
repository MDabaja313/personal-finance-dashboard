"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import { clearMonthlyPlan, setMonthlyPlan } from "@/lib/data/mutations/monthly-plans";
import { monthKey } from "@/lib/finance/dates";
import { makeMonthlyPlanSchema } from "@/lib/validation/monthly-plans";

/**
 * Monthly-plan Server Actions — set the owner's expected income for the current
 * month, or clear it.
 *
 * The same four steps as every other write in this application: validate,
 * `attempt()` the mutation, redirect or return a safe `ActionState`, then
 * revalidate precisely.
 *
 * ## The month comes from the server, never the client
 *
 * The application only ever manages the owner's *current* month, exactly as it
 * does for budgets, so both actions resolve the owner's own calendar day
 * (`resolveToday()`, from `profiles.timezone`) and derive the period from it. A
 * period is never read out of `FormData`, so a hand-crafted request naming a
 * different month has nothing to submit that this layer will accept — and
 * `monthly_plans.period` is INSERT-only at the grant layer, so an existing
 * plan's month cannot be moved either.
 *
 * ## Revalidation
 *
 * Exactly `/budgets`. An expected-income figure is planning context for the
 * Monthly Plan summary and appears nowhere else: it is not a transaction, it
 * moves no balance, it reaches no chart, and — unlike a budget, whose
 * utilisation the dashboard renders — nothing outside `/budgets` reads it at
 * all. Listing `/dashboard` out of habit would be revalidating a page that
 * cannot have changed.
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/monthly-plans.ts` calls
 * `getOwnerId()`, which throws `unauthorized` without verified claims; this
 * layer only turns that into `redirect("/login")`.
 */

const PLAN_ROUTES = ["/budgets"] as const;

function revalidatePlanRoutes(): void {
  for (const route of PLAN_ROUTES) revalidatePath(route);
}

/** The text field worth echoing back so a rejected form is not blanked. */
const PLAN_FORM_FIELDS = ["expectedIncome"] as const;

/**
 * The one `conflict` a person can act on: a resubmission under a stale
 * submission key against a plan that has since moved. An exact-match retry
 * never reaches this branch — it reports success — and a natural-key race is
 * resolved by the mutation layer rather than surfaced.
 */
const PLAN_CONFLICT =
  "Your expected income was changed somewhere else. Refresh the page and try again.";

export async function setMonthlyPlanAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, PLAN_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeMonthlyPlanSchema(monthKey(today.today)).safeParse({
    id: formData.get("id"),
    expectedIncome: formData.get("expectedIncome"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => setMonthlyPlan(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(PLAN_CONFLICT, values);
    return outcome.state;
  }

  revalidatePlanRoutes();

  // Deliberately indistinguishable from a first-time set — an exact retry
  // accomplished what the person asked for.
  return succeeded();
}

/**
 * Clears the current month's plan, returning it to "not set".
 *
 * Takes no fields at all — not even a row id. The owner comes from
 * `getOwnerId()` and the month from `getToday()`, so there is nothing in the
 * submission for a hand-crafted request to aim at a different row.
 *
 * Declared with **no parameters**, which is deliberate rather than terse. Every
 * other action in this application names `(previousState, formData)` because it
 * reads the second one; this one reads neither, and a signature that accepted a
 * `FormData` it never opens would suggest there is something in it that
 * matters. It still satisfies `FormAction` — a function may declare fewer
 * parameters than its call site supplies — so `useActionState` drives it
 * exactly like the others.
 */
export async function clearMonthlyPlanAction(): Promise<ActionState> {
  const today = await resolveToday();
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const outcome = await attempt(() => clearMonthlyPlan(monthKey(today.today)));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidatePlanRoutes();
  return succeeded();
}
