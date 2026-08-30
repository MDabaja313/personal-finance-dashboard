"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import type { ActionState } from "@/lib/actions/types";
import { createBill, setBillArchived, updateBill } from "@/lib/data/mutations/bills";
import { billArchiveSchema, billCreateSchema, billUpdateSchema } from "@/lib/validation/bills";

/**
 * Bill Server Actions — the same four steps as every other write in this
 * application: validate, `attempt()` the mutation, redirect or return a safe
 * `ActionState`, then revalidate precisely.
 *
 * No `resolveToday()` here, and that is a decision rather than an omission. A
 * bill's `anchorDate` is the recurrence anchor and the first due date the
 * owner wants tracked — a future one (a lease starting in November) and a past
 * one (an invoice entered late, already overdue) are both ordinary. It is not
 * a posted-ledger fact, so it takes no ceiling. The owner's calendar day still
 * governs everything the *schedule* does — the rebuild cutoff and the rolling
 * horizon — but that is computed inside `public.maintain_bill_schedule` from
 * `profiles.timezone`, where it cannot disagree with itself.
 * `lib/actions/bill-occurrences.ts` is where a bill surface does need `today`,
 * because `paidOn` is a claim that something already happened.
 *
 * Where authentication happens: not here. Every function in
 * `lib/data/mutations/bills.ts` calls `getOwnerId()`, which throws
 * `unauthorized` without verified claims; this layer only turns that into
 * `redirect("/login")`.
 */

/**
 * The routes a bill write must invalidate — the only two that read a bill.
 *
 * `/bills` renders the management surface and `/dashboard` renders the
 * upcoming-bill projection (`getUpcomingBills`). Nothing else is listed, and
 * each absence is a checked claim rather than an oversight: `/accounts`,
 * `/transactions`, `/budgets`, `/analytics` and `/goals` read balances, the
 * ledger, category rollups and goals, and **a bill write touches none of
 * them** — creating, editing or archiving a bill writes no transaction, moves
 * no balance, and produces no row any of those pages sums. That is the same
 * reason no bill action refreshes the net-worth snapshot.
 */
const BILL_ROUTES = ["/bills", "/dashboard"] as const;

function revalidateBillRoutes(): void {
  for (const route of BILL_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const BILL_FORM_FIELDS = ["name", "amount", "frequency", "anchorDate"] as const;

/**
 * `bills` carries no unique constraint beyond its primary key, so on a create
 * `conflict` can only mean the idempotency key: either an edited resubmission
 * under a stale key, or a key belonging to another owner. One message covers
 * both, exactly as it does for goals and ordinary transactions.
 */
const BILL_CONFLICT =
  "A different bill was already saved with that submission. Refresh the page and try again.";

/**
 * The `invalid_input` cases a person can act on, all of which come from a
 * preflight in `lib/data/mutations/bills.ts` or from `assert_bill_refs()`: an
 * archived bill, an archived or non-expense category, an archived account.
 * One sentence covers the set, because the form's own selectors already offer
 * active options only — reaching this means the page was stale.
 */
const BILL_REFERENCE_PROBLEM =
  "That bill, category or account is archived or no longer usable. Refresh the page and try again.";

export async function createBillAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, BILL_FORM_FIELDS);

  const parsed = billCreateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    amount: formData.get("amount"),
    frequency: formData.get("frequency"),
    anchorDate: formData.get("anchorDate"),
    categoryId: formData.get("categoryId"),
    accountId: formData.get("accountId"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createBill(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "conflict") return failed(BILL_CONFLICT, values);
    if (outcome.reason === "invalid_input") return failed(BILL_REFERENCE_PROBLEM, values);
    return outcome.state;
  }

  revalidateBillRoutes();

  // Deliberately indistinguishable from a first-time create — an exact retry
  // accomplished what the person asked for, and did not create a second
  // recurring obligation.
  return succeeded();
}

export async function updateBillAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, BILL_FORM_FIELDS);

  const parsed = billUpdateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    amount: formData.get("amount"),
    frequency: formData.get("frequency"),
    anchorDate: formData.get("anchorDate"),
    categoryId: formData.get("categoryId"),
    accountId: formData.get("accountId"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateBill(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(BILL_REFERENCE_PROBLEM, values);
    return outcome.state;
  }

  revalidateBillRoutes();
  return succeeded();
}

export async function setBillArchivedAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = billArchiveSchema.safeParse({
    id: formData.get("id"),
    archived: formData.get("archived"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => setBillArchived(parsed.data.id, parsed.data.archived));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateBillRoutes();
  return succeeded();
}
