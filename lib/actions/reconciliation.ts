"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import {
  deleteAdjustment,
  getAccountTypeForReconciliation,
  reconcileAccount,
} from "@/lib/data/mutations/reconciliation";
import {
  adjustmentDeleteSchema,
  makeReconcileSchema,
} from "@/lib/validation/reconciliation";

/**
 * Reconciliation Server Actions.
 *
 * The same steps as every other dated write in this application, in the same
 * order:
 *
 *   0. Resolve the owner's calendar day (`resolveToday()`).
 *   1. Read the account's stored type, so the schema knows what its balance
 *      field means.
 *   2. Parse and validate the `FormData` (`lib/validation/reconciliation.ts`).
 *   3. Run the mutation inside `attempt()` — data work only.
 *   4. On failure, either redirect (`unauthenticated`) or return a safe
 *      `ActionState`.
 *   5. On success, revalidate precisely the routes the write changed.
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/reconciliation.ts` calls
 * `getOwnerId()`, and `public.reconcile_account` derives the owner from
 * `auth.uid()` in the database — so the check is inside the thing being
 * protected, twice. What this layer adds is the *response*: an ended session
 * is the one failure a form cannot recover from, so `unauthenticated` becomes
 * `redirect("/login")`, called outside `attempt()` because it signals by
 * throwing and `attempt()` catches everything.
 *
 * ## Why step 1 is a separate database read
 *
 * The balance field means "your actual balance" on a checking account and
 * "what you currently owe" on a credit card, and only the *stored* account
 * type can decide which. Taking it from the submission would let a
 * hand-crafted request pick its own sign convention, so it is read here — the
 * same arrangement `updateAccountAction` uses for the immutable account type,
 * and for the same reason. The mutation layer re-reads it independently
 * regardless, so this read only ever decides which message a person gets.
 */

/**
 * The routes a reconciliation changes.
 *
 * Four, and `/budgets` is deliberately absent for exactly the reason it is
 * absent from the movement routes: budget utilisation is `spendingByCategory`
 * over rows `countsAsSpending` admits, and that predicate is an allowlist of
 * `expense` and `refund`. An adjustment is excluded **by kind**, not by
 * carrying no category and not by its sign, so no reconciliation can change a
 * figure `/budgets` renders.
 *
 * - `/transactions` lists the adjustment row.
 * - `/accounts` renders the derived balance the adjustment just corrected.
 * - `/dashboard` renders net worth, assets and liabilities, plus the recent
 *   transactions list.
 * - `/analytics` renders account composition and the net-worth chart — the
 *   latter reading the snapshot this write also refreshed.
 *
 * `revalidatePath("/")` would throw away every cached route in the application
 * to refresh four.
 */
const RECONCILIATION_ROUTES = ["/transactions", "/dashboard", "/accounts", "/analytics"] as const;

function revalidateReconciliationRoutes(): void {
  for (const route of RECONCILIATION_ROUTES) revalidatePath(route);
}

/**
 * The text fields worth echoing back so a rejected form is not blanked.
 *
 * `accountId` is absent: it is a hidden field the card supplies from data the
 * page already rendered, a person cannot retype one, and echoing it back would
 * put a caller-supplied UUID into `ActionState.values` for no benefit.
 */
const RECONCILE_FORM_FIELDS = ["asOf", "balance"] as const;

/**
 * Fixed, developer-authored messages for the failures a person can act on.
 *
 * Chosen from constants rather than derived from the error, for the reason
 * `lib/actions/result.ts` documents: an `AppError`'s message may name a column
 * or an operation, and its `cause` carries the raw driver payload. The
 * *classification* selects the sentence; neither is ever read.
 */
const ACCOUNT_UNUSABLE =
  "That account can no longer be reconciled. Refresh the page and try again.";
const NOT_AN_ADJUSTMENT =
  "Only a balance adjustment can be removed here. Refresh the page and try again.";

export async function reconcileAccountAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, RECONCILE_FORM_FIELDS);

  const accountId = formData.get("accountId");
  if (typeof accountId !== "string" || accountId === "") {
    return failed("That item no longer exists.", values);
  }

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const typeOutcome = await attempt(() => getAccountTypeForReconciliation(accountId), values);
  if (!typeOutcome.ok) {
    if (typeOutcome.reason === "unauthenticated") redirect("/login");
    return typeOutcome.state;
  }

  const parsed = makeReconcileSchema({
    today: today.today,
    accountType: typeOutcome.value,
  }).safeParse({
    accountId,
    asOf: formData.get("asOf"),
    balance: formData.get("balance"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => reconcileAccount(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // Once validation has passed, `invalid_input` here can only mean the
    // account stopped being reconcilable between the reads above and the
    // write — archived in another tab, or a stale page. "Refresh and try
    // again" is the honest remedy; everything a person hits while actually
    // filling the form in (a future date, an unparseable amount, a negative
    // amount owed) is a field error raised before a query is issued.
    if (outcome.reason === "invalid_input") return failed(ACCOUNT_UNUSABLE, values);
    return outcome.state;
  }

  // Revalidated even when the delta was zero and nothing was written. The
  // *write* is what was skipped, not the render: the page was rendered before
  // the form was opened, and refusing to refresh it would be an optimization
  // visible as staleness.
  revalidateReconciliationRoutes();

  // Deliberately indistinguishable from a reconciliation that wrote a row. In
  // both cases the account's balance now equals what the person said it was,
  // which is what they asked for; reporting "nothing to do" differently would
  // invite them to submit again.
  return succeeded();
}

export async function deleteAdjustmentAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = adjustmentDeleteSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => deleteAdjustment(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(NOT_AN_ADJUSTMENT);
    return outcome.state;
  }

  revalidateReconciliationRoutes();
  return succeeded();
}
