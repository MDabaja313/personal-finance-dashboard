"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
} from "@/lib/data/mutations/transactions";
import {
  makeCreateTransactionSchema,
  makeUpdateTransactionSchema,
  transactionDeleteSchema,
} from "@/lib/validation/transactions";

/**
 * Transaction Server Actions.
 *
 * The same four steps as `lib/actions/accounts.ts`, in the same order, with one
 * extra step in front of them:
 *
 *   0. Resolve the owner's calendar day (`getToday()`).
 *   1. Parse and validate the `FormData` (`lib/validation/transactions.ts`).
 *   2. Run the mutation inside `attempt()` — data work only.
 *   3. On failure, either redirect (`unauthenticated`) or return a safe
 *      `ActionState`.
 *   4. On success, revalidate precisely the routes the write changed.
 *
 * ## Why `today` is fetched here, and how its own failures are handled
 *
 * A transaction has a date, and "not in the future" has to mean the future
 * where the *person* is. `resolveToday()` (`lib/actions/today.ts`) resolves the
 * owner's own calendar day through `getToday()` and turns that read's own
 * failures into a redirect decision or a safe `ActionState` — see that module
 * for the full rationale. It is shared with `lib/actions/movements.ts`, because
 * a movement is dated by the same rule and must fail the same way.
 *
 * `redirect()` stays outside `attempt()` in every case, because it signals by
 * throwing and `attempt()` catches everything. Nothing here inspects a `NEXT_*`
 * digest, and nothing needs to: `attempt()` only ever wraps `lib/data/**`
 * calls, and that layer is fenced away from `next/navigation` and `next/cache`
 * by ESLint, so a control-flow throw cannot occur inside it.
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/transactions.ts` calls
 * `getOwnerId()`, which verifies the request's own claims and throws
 * `unauthorized` when there are none — so the check is inside the thing being
 * protected rather than in front of it, and cannot be bypassed by a caller who
 * skipped a guard. What this layer adds is the *response* to that failure.
 */

/**
 * The routes a transaction write changes.
 *
 * Every one of them reads the ledger, and all five are needed:
 *
 * - `/transactions` lists the rows themselves.
 * - `/dashboard` renders the month's income/spending/cash-flow KPIs, recent
 *   transactions, spending by category, and the budget section.
 * - `/accounts` renders derived balances — `account_balances` is
 *   `opening + SUM(ledger)`, so every account figure moves with a single row.
 * - `/budgets` renders utilisation, which is spending per category per month.
 * - `/analytics` renders the income/expense, cash-flow, savings-rate and
 *   category-spending charts.
 *
 * `/bills` and `/goals` are deliberately absent: neither resolves a transaction
 * or a balance. And `revalidatePath("/")` would throw away every cached route
 * in the application to refresh five.
 */
const TRANSACTION_ROUTES = [
  "/transactions",
  "/dashboard",
  "/accounts",
  "/budgets",
  "/analytics",
] as const;

function revalidateTransactionRoutes(): void {
  for (const route of TRANSACTION_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const TRANSACTION_FORM_FIELDS = [
  "accountId",
  "date",
  "merchant",
  "kind",
  "categoryId",
  "amount",
] as const;

/**
 * Fixed, developer-authored messages for the failures a person can act on.
 *
 * Chosen from constants for the same reason `lib/actions/result.ts` chooses its
 * own that way: the underlying `AppError`'s message may name a column or an
 * operation, and its `cause` carries the raw driver payload. Neither is ever
 * read — the *classification* is what selects the sentence.
 *
 * `TARGETS_UNUSABLE` covers every `invalid_input` these operations can produce:
 * an archived account, an archived category, a category whose kind no longer
 * matches, a movement leg, an adjustment. The pickers only ever offer active,
 * kind-compatible options, so reaching any of them means the page is stale or
 * the request was hand-crafted — and "refresh and try again" is the honest
 * remedy for both. The failures a person actually hits while filling the form
 * in — a missing merchant, a malformed amount, a future date — are all field
 * errors raised by validation before a query is issued.
 */
const TARGETS_UNUSABLE =
  "That account or category can no longer be used for this transaction. Refresh the page and try again.";
const DUPLICATE_SUBMISSION =
  "A different transaction was already saved from this form. Refresh the page and try again.";
const BILL_LINKED = "Unmark that bill as paid first, then delete the transaction.";

export async function createTransactionAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, TRANSACTION_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeCreateTransactionSchema(today.today).safeParse({
    id: formData.get("id"),
    accountId: formData.get("accountId"),
    date: formData.get("date"),
    merchant: formData.get("merchant"),
    kind: formData.get("kind"),
    categoryId: formData.get("categoryId"),
    amount: formData.get("amount"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createTransaction(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // On create, `conflict` can only be the idempotency key: either the same
    // key already holds a *different* row, or it belongs to another owner and
    // is invisible. Both mean "this submission cannot be saved as posted", and
    // neither is something the person can fix by editing a field.
    if (outcome.reason === "conflict") return failed(DUPLICATE_SUBMISSION, values);
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE, values);
    return outcome.state;
  }

  revalidateTransactionRoutes();

  // Deliberately indistinguishable from a first-time create. A retry that
  // matched an identical stored row *did* accomplish what the person asked
  // for; reporting it differently would invite them to submit again.
  return succeeded();
}

export async function updateTransactionAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, TRANSACTION_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeUpdateTransactionSchema(today.today).safeParse({
    id: formData.get("id"),
    accountId: formData.get("accountId"),
    date: formData.get("date"),
    merchant: formData.get("merchant"),
    kind: formData.get("kind"),
    categoryId: formData.get("categoryId"),
    amount: formData.get("amount"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateTransaction(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE, values);
    return outcome.state;
  }

  revalidateTransactionRoutes();
  return succeeded();
}

export async function deleteTransactionAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = transactionDeleteSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => deleteTransaction(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // On delete, `conflict` has exactly one meaning: a bill occurrence records
    // this transaction as its payment. That is worth a specific sentence —
    // "that conflicts with something that already exists" is not actionable.
    if (outcome.reason === "conflict") return failed(BILL_LINKED);
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE);
    return outcome.state;
  }

  revalidateTransactionRoutes();
  return succeeded();
}
