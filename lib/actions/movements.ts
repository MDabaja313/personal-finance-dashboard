"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import { resolveToday } from "@/lib/actions/today";
import type { ActionState } from "@/lib/actions/types";
import {
  createMovement,
  deleteMovement,
  replaceMovement,
} from "@/lib/data/mutations/movements";
import {
  makeCreateMovementSchema,
  makeUpdateMovementSchema,
  movementDeleteSchema,
} from "@/lib/validation/movements";

/**
 * Movement Server Actions — transfers and credit-card payments.
 *
 * The same five steps as `lib/actions/transactions.ts`, in the same order:
 *
 *   0. Resolve the owner's calendar day (`resolveToday()`).
 *   1. Parse and validate the `FormData` (`lib/validation/movements.ts`).
 *   2. Run the mutation inside `attempt()` — data work only.
 *   3. On failure, either redirect (`unauthenticated`) or return a safe
 *      `ActionState`.
 *   4. On success, revalidate precisely the routes the write changed.
 *
 * ## A movement is one submission, not two
 *
 * Every action here operates on the *movement*, never on a leg. Editing means
 * replacing the pair atomically; deleting means deleting the parent and letting
 * the cascade take both legs. There is deliberately no action that takes a leg
 * id, and `lib/actions/transactions.ts` refuses one from the other direction —
 * both surfaces are disjoint, and the database enforces the same split
 * independently (`transactions_update_own_ordinary` and
 * `transactions_delete_own_non_movement` both carry `movement_id IS NULL`).
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/movements.ts` calls
 * `getOwnerId()`, and the two RPCs beneath it derive the owner from
 * `auth.uid()` in the database — so the check is inside the thing being
 * protected, twice, rather than in front of it. What this layer adds is the
 * *response*: an ended session is the one failure a form cannot recover from,
 * so `unauthenticated` becomes `redirect("/login")`, called outside `attempt()`
 * because it signals by throwing and `attempt()` catches everything.
 *
 * Nothing here inspects a `NEXT_*` digest, and nothing needs to: `attempt()`
 * only ever wraps `lib/data/**` calls, and that layer is fenced away from
 * `next/navigation` and `next/cache` by ESLint.
 */

/**
 * The routes a movement write changes.
 *
 * Four, and the omission is the interesting one:
 *
 * - `/transactions` lists both legs.
 * - `/accounts` renders derived balances — `account_balances` is
 *   `opening + SUM(ledger)`, and a movement moves two of them at once.
 * - `/dashboard` renders those same balances (net worth, assets, liabilities)
 *   and the recent-transactions list, which shows legs.
 * - `/analytics` renders account composition and the net-worth chart, both of
 *   which are built from balances.
 *
 * **`/budgets` is deliberately absent.** A budget is utilisation of a category
 * in a month, computed by `spendingByCategory` over rows `countsAsSpending`
 * admits — and that predicate is an allowlist of `expense` and `refund`, so a
 * movement leg is excluded **by kind**, not by happening to be signed a
 * particular way or by happening to carry no category. Both facts hold
 * independently (a leg also carries no `category_id` at all, by
 * `transactions_movement_no_category_ck`), so no movement write can change any
 * figure that page renders. Revalidating it would be cargo-culted from the
 * transaction routes rather than derived from what the page reads.
 *
 * `/bills` and `/goals` are absent for the same reason they are absent from the
 * transaction routes: neither resolves a ledger row or a balance. And
 * `revalidatePath("/")` would throw away every cached route in the application
 * to refresh four.
 */
const MOVEMENT_ROUTES = ["/transactions", "/dashboard", "/accounts", "/analytics"] as const;

function revalidateMovementRoutes(): void {
  for (const route of MOVEMENT_ROUTES) revalidatePath(route);
}

/**
 * The text fields worth echoing back so a rejected form is not blanked.
 *
 * The three ids are absent on purpose. They are hidden inputs the form mints
 * for itself, a person cannot retype one, and echoing them back would put
 * caller-supplied UUIDs into `ActionState.values` — the one part of an
 * `ActionState` sourced from untrusted input — for no benefit. The form
 * regenerates or re-supplies them from its own state on the next render.
 */
const MOVEMENT_FORM_FIELDS = ["kind", "date", "fromAccountId", "toAccountId", "amount"] as const;

/**
 * Fixed, developer-authored messages for the failures a person can act on.
 *
 * Chosen from constants rather than derived from the error, for the reason
 * `lib/actions/result.ts` documents: an `AppError`'s message may name a column
 * or an operation, and its `cause` carries the raw driver payload. The
 * *classification* selects the sentence; neither is ever read.
 *
 * `TARGETS_UNUSABLE` covers every `invalid_input` these operations can produce
 * once validation has passed: an archived account on either side, a card
 * payment aimed at something that is not a credit account, or a movement that
 * stopped being editable between the preflight and the write. The pickers only
 * ever offer active accounts, and the form only offers a credit account as a
 * card payment's destination, so reaching any of them means the page is stale
 * or the request was hand-crafted — and "refresh and try again" is the honest
 * remedy for both. Everything a person hits while actually filling the form in
 * — the same account twice, an amount of zero, a future date — is a field error
 * raised before a query is issued.
 */
const TARGETS_UNUSABLE =
  "Those accounts can no longer be used for this transfer. Refresh the page and try again.";
const DUPLICATE_SUBMISSION =
  "A different transfer was already saved from this form. Refresh the page and try again.";

/** The raw form fields, read once, shared by create and edit. */
function movementFieldsFrom(formData: FormData) {
  return {
    id: formData.get("id"),
    sourceLegId: formData.get("sourceLegId"),
    destinationLegId: formData.get("destinationLegId"),
    kind: formData.get("kind"),
    date: formData.get("date"),
    fromAccountId: formData.get("fromAccountId"),
    toAccountId: formData.get("toAccountId"),
    amount: formData.get("amount"),
  };
}

export async function createMovementAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, MOVEMENT_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeCreateMovementSchema(today.today).safeParse(movementFieldsFrom(formData));

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createMovement(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // On create, `conflict` can only be the idempotency key: either the same
    // key already holds a *different* movement, or it belongs to another owner
    // and is invisible. Both mean "this submission cannot be saved as posted",
    // and neither is something the person can fix by editing a field.
    if (outcome.reason === "conflict") return failed(DUPLICATE_SUBMISSION, values);
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE, values);
    return outcome.state;
  }

  revalidateMovementRoutes();

  // Deliberately indistinguishable from a first-time create. A retry that
  // matched an identical stored movement *did* accomplish what the person asked
  // for; reporting it differently would invite them to submit again.
  return succeeded();
}

export async function updateMovementAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, MOVEMENT_FORM_FIELDS);

  const today = await resolveToday(values);
  if (!today.ok) {
    if (today.redirectToLogin) redirect("/login");
    return today.state;
  }

  const parsed = makeUpdateMovementSchema(today.today).safeParse(movementFieldsFrom(formData));

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => replaceMovement(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE, values);
    return outcome.state;
  }

  // Revalidated even when the mutation short-circuited as unchanged. The write
  // is what was skipped, not the render: the page the person is looking at was
  // rendered before they opened the form, and refusing to refresh it would be
  // an optimization visible as staleness.
  revalidateMovementRoutes();
  return succeeded();
}

export async function deleteMovementAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = movementDeleteSchema.safeParse({ id: formData.get("id") });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() => deleteMovement(parsed.data.id));

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    if (outcome.reason === "invalid_input") return failed(TARGETS_UNUSABLE);
    return outcome.state;
  }

  revalidateMovementRoutes();
  return succeeded();
}
