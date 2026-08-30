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
 * clear `paid_on` and `transaction_id`, so they share one action and the UI
 * picks the word from the occurrence's current status. Publishing two
 * endpoints for one transition would be two attack surfaces for one behavior.
 *
 * `resolveToday()` is required here, unlike `lib/actions/bills.ts`: `paidOn`
 * is a claim that a payment already happened, so it is ceilinged at the
 * owner's own calendar day — the same source `guard_bill_occurrence_transition()`
 * reads (`profiles.timezone`), so the form's message and the database's
 * refusal can never disagree.
 *
 * ## These actions revalidate two routes and refresh no snapshot
 *
 * A status change writes exactly three columns of one `bill_occurrences` row.
 * It creates no transaction, moves no balance, and changes no figure
 * `/accounts`, `/transactions`, `/budgets`, `/analytics` or `/goals` renders —
 * including when a transaction is linked, since the link alters nothing about
 * that transaction. So `/bills` and `/dashboard` are the complete list, and
 * `refreshCurrentSnapshotAfter` is deliberately not reachable from this file.
 *
 * Where authentication happens: not here. Every function in
 * `lib/data/mutations/bill-occurrences.ts` calls `getOwnerId()`.
 */

/** The only two routes that render an occurrence or a projection over one. */
const OCCURRENCE_ROUTES = ["/bills", "/dashboard"] as const;

function revalidateOccurrenceRoutes(): void {
  for (const route of OCCURRENCE_ROUTES) revalidatePath(route);
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
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => markBillOccurrencePaid(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(ALREADY_SKIPPED, values);
    return outcome.state;
  }

  revalidateOccurrenceRoutes();
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

  revalidateOccurrenceRoutes();
  return succeeded();
}

/**
 * Returns one occurrence to `scheduled` — rendered as "Unmark paid" on a paid
 * occurrence and "Unskip" on a skipped one.
 *
 * Clearing a payment link here is what makes the linked transaction deletable
 * again; the transaction itself is untouched, which is exactly why the
 * transaction and movement delete paths say "Unmark that bill as paid first."
 * rather than refusing outright.
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

  revalidateOccurrenceRoutes();
  return succeeded();
}
