"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import {
  markBillOccurrencePaid,
  restoreBillOccurrence,
  skipBillOccurrence,
} from "@/lib/data/mutations/bill-occurrences";
import {
  billOccurrenceRestoreSchema,
  billOccurrenceSkipSchema,
  makeBillOccurrencePaidSchema,
} from "@/lib/validation/bill-occurrences";

/**
 * Bill-occurrence Server Actions — the four supported status changes, as three
 * endpoints.
 *
 * Mark paid, skip, and restore-to-scheduled. "Unmark paid" and "Unskip" are
 * the same transition wearing two labels: both land on `scheduled` and both
 * clear the payment fields, so they share one action and the UI picks the word
 * from the occurrence's current status. Publishing two endpoints for one
 * transition would be two attack surfaces for one behavior.
 *
 * `resolveToday()` is required here, unlike `lib/actions/bills.ts`: `paidOn`
 * is a claim that a payment already happened, so it is ceilinged at the
 * owner's own calendar day — the same source `guard_bill_occurrence_transition()`
 * reads (`profiles.timezone`), so the form's message and the database's
 * refusal can never disagree. It is also the date a generated expense takes,
 * which `assert_transaction_refs()` ceilings from the identical expression.
 *
 * ## Revalidation follows the ledger, not the operation
 *
 * Through CP7 every occurrence write revalidated exactly `/bills` and
 * `/dashboard`, because a status change moved no figure anywhere else. Phase 8
 * CP1 makes that true of *most* occurrence writes rather than all of them:
 *
 * - **Skip, unskip, a link, an unlink, and a status-only payment** still change
 *   nothing but the occurrence. `/accounts`, `/transactions`, `/budgets` and
 *   `/analytics` cannot render a figure any of them moved, so they are not
 *   revalidated and the snapshot is not refreshed.
 * - **A generated payment, and its removal**, create or delete an ordinary
 *   expense. That moves an account balance, the month's spending and cash flow,
 *   that category's budget utilisation, and four charts — so every route that
 *   renders one of those is revalidated, and the current month's balance
 *   snapshot is recomputed.
 *
 * Which of the two happened is the database's answer, carried back on
 * `ledgerChanged`, never inferred here from the shape of the submission.
 *
 * Where authentication happens: not here. Every function in
 * `lib/data/mutations/bill-occurrences.ts` calls `getOwnerId()`.
 */

/** The routes that render an occurrence or a projection over one, and nothing more. */
const OCCURRENCE_ROUTES = ["/bills", "/dashboard"] as const;

/**
 * Everything above, plus every route that renders a figure an ordinary expense
 * moves. The same set a transaction write invalidates, in the same order, plus
 * `/bills` — because the occurrence changed too.
 */
const LEDGER_OCCURRENCE_ROUTES = [
  "/bills",
  "/dashboard",
  "/transactions",
  "/accounts",
  "/budgets",
  "/analytics",
] as const;

function revalidateOccurrenceRoutes(ledgerChanged: boolean): void {
  const routes = ledgerChanged ? LEDGER_OCCURRENCE_ROUTES : OCCURRENCE_ROUTES;
  for (const route of routes) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected mark-paid form is not blanked. */
const PAID_FORM_FIELDS = ["paidOn", "transactionId"] as const;

/**
 * The `invalid_input` cases a person can act on. Both come from a preflight in
 * `lib/data/mutations/bill-occurrences.ts`, and both name the two-step
 * correction the state machine intends — a direct paid ↔ skipped conversion is
 * not a supported transition, in the database or here.
 */
const ALREADY_SKIPPED = "That occurrence is skipped. Unskip it before marking it paid.";
const ALREADY_PAID = "That occurrence is marked paid. Unmark it before skipping it.";

export async function markBillOccurrencePaidAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, PAID_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeBillOccurrencePaidSchema(today.today).safeParse({
    id: formData.get("id"),
    paidOn: formData.get("paidOn"),
    transactionId: formData.get("transactionId"),
    generatedTransactionId: formData.get("generatedTransactionId"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => markBillOccurrencePaid(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(ALREADY_SKIPPED, values);
    return outcome.state;
  }

  revalidateOccurrenceRoutes(outcome.value.ledgerChanged);
  return succeeded();
}

export async function skipBillOccurrenceAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = billOccurrenceSkipSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => skipBillOccurrence(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(ALREADY_PAID);
    return outcome.state;
  }

  // Skipping creates and removes nothing, always — so the narrow list, always.
  revalidateOccurrenceRoutes(false);
  return succeeded();
}

/**
 * Returns one occurrence to `scheduled` — rendered as "Unmark paid" on a paid
 * occurrence and "Unskip" on a skipped one.
 *
 * When the payment was one this application *generated*, the transaction it
 * created is removed in the same database transaction as the status change.
 * When the payment was a transaction the owner *linked*, clearing the reference
 * is all that happens — the transaction itself is untouched and becomes
 * deletable again, which is exactly why the transaction and movement delete
 * paths say "Unmark that bill as paid first." rather than refusing outright.
 * Which of the two applies is stored on the occurrence and enforced in SQL; see
 * `lib/data/mutations/bill-occurrences.ts`.
 */
export async function restoreBillOccurrenceAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = billOccurrenceRestoreSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => restoreBillOccurrence(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateOccurrenceRoutes(outcome.value.ledgerChanged);
  return succeeded();
}
