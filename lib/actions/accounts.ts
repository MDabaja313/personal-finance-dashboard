"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { attempt, failed, invalid, submittedValues, succeeded } from "@/lib/actions/result";
import type { ActionState } from "@/lib/actions/types";
import {
  createAccount,
  getAccountTypeForUpdate,
  setAccountArchived,
  updateAccount,
} from "@/lib/data/mutations/accounts";
import {
  accountArchiveSchema,
  accountCreateSchema,
  accountUpdateSchema,
} from "@/lib/validation/accounts";

/**
 * Account Server Actions.
 *
 * Each one is the same four steps, in the same order, and the order is the
 * contract:
 *
 *   1. Parse and validate the `FormData` (`lib/validation/accounts.ts`).
 *   2. Run the mutation inside `attempt()` — data work only.
 *   3. On failure, either redirect (`unauthenticated`) or return a safe
 *      `ActionState`.
 *   4. On success, revalidate precisely the routes whose rendered output the
 *      write actually changed.
 *
 * ## Where authentication happens
 *
 * Not here. Every function in `lib/data/mutations/accounts.ts` calls
 * `getOwnerId()`, which verifies the request's own claims and throws
 * `unauthorized` when there are none — so the check is inside the thing being
 * protected rather than in front of it, and cannot be bypassed by a caller who
 * skipped a guard. What this layer adds is the *response*: an ended session is
 * the one failure a form cannot recover from, so `unauthenticated` becomes a
 * `redirect("/login")` instead of an error message. `redirect()` is called
 * outside `attempt()`, after it has returned, because it signals by throwing
 * and `attempt()` catches everything.
 *
 * ## Why no `getToday()`
 *
 * Accounts carry no date. Reading the owner's calendar day would mean a
 * `profiles` query per submission for a value nothing uses — the CP1 rule is
 * that `today` is obtained only when it is genuinely needed.
 *
 * ## No NEXT_* digest inspection anywhere
 *
 * `attempt()` wraps a `lib/data/mutations/**` call and nothing else, and that
 * layer is fenced away from `next/navigation` and `next/cache` by ESLint — so
 * a Next.js control-flow throw cannot occur inside it, and nothing here needs
 * to recognize one by its private digest string.
 */

/**
 * The routes an account write changes.
 *
 * `/accounts` lists them; the dashboard renders the account summary and the
 * net-worth KPIs; analytics renders account composition and the net-worth
 * trend. Nothing else reads an account's metadata or balance, so nothing else
 * is invalidated — `revalidatePath("/")` would throw away every cached route in
 * the application to refresh three.
 */
const ACCOUNT_ROUTES = ["/accounts", "/dashboard", "/analytics"] as const;

function revalidateAccountRoutes(): void {
  for (const route of ACCOUNT_ROUTES) revalidatePath(route);
}

/** The text fields worth echoing back so a rejected form is not blanked. */
const ACCOUNT_FORM_FIELDS = [
  "name",
  "institution",
  "type",
  "openingBalance",
  "creditLimit",
  "interestRate",
] as const;

/**
 * Fixed, developer-authored messages for the two situations a person can
 * actually do something about.
 *
 * Both are chosen from a constant table for the same reason
 * `lib/actions/result.ts` chooses its own that way: the underlying `AppError`'s
 * message may name a column or an operation, and its `cause` carries the raw
 * driver payload. Neither is ever read.
 */
const OPENING_BALANCE_LOCKED =
  "The opening balance cannot change once the account has transactions.";
const ARCHIVE_NEEDS_ZERO_BALANCE = "An account can only be archived once its balance is zero.";

export async function createAccountAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, ACCOUNT_FORM_FIELDS);

  const parsed = accountCreateSchema.safeParse({
    name: formData.get("name"),
    institution: formData.get("institution"),
    type: formData.get("type"),
    openingBalance: formData.get("openingBalance"),
    creditLimit: formData.get("creditLimit"),
    interestRate: formData.get("interestRate"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => createAccount(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    return outcome.state;
  }

  revalidateAccountRoutes();
  return succeeded();
}

export async function updateAccountAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const values = submittedValues(formData, ACCOUNT_FORM_FIELDS);

  const id = formData.get("id");
  if (typeof id !== "string" || id === "") {
    return failed("That item no longer exists.", values);
  }

  // The account's *current* type parameterizes the schema: `type` is immutable,
  // so which optional fields are legal must be judged against the row as it
  // stands, never against a type resubmitted from the browser. This read is
  // also what turns a deleted or foreign id into a clean "no longer exists".
  const typeOutcome = await attempt(() => getAccountTypeForUpdate(id), values);
  if (!typeOutcome.ok) {
    if (typeOutcome.reason === "unauthenticated") redirect("/login");
    return typeOutcome.state;
  }

  const parsed = accountUpdateSchema(typeOutcome.value).safeParse({
    id,
    name: formData.get("name"),
    institution: formData.get("institution"),
    openingBalance: formData.get("openingBalance"),
    creditLimit: formData.get("creditLimit"),
    interestRate: formData.get("interestRate"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors, values);

  const outcome = await attempt(() => updateAccount(parsed.data), values);

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // `accounts` carries no unique constraint a person can collide with, so on
    // this operation a `conflict` can only be the opening-balance preflight.
    // Saying so is worth a sentence; "that conflicts with something" is not.
    if (outcome.reason === "conflict") return failed(OPENING_BALANCE_LOCKED, values);
    return outcome.state;
  }

  revalidateAccountRoutes();
  return succeeded();
}

export async function setAccountArchivedAction(
  _previousState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = accountArchiveSchema.safeParse({
    id: formData.get("id"),
    archived: formData.get("archived"),
  });

  if (!parsed.success) return invalid(z.flattenError(parsed.error).fieldErrors);

  const outcome = await attempt(() =>
    setAccountArchived(parsed.data.id, parsed.data.archived)
  );

  if (!outcome.ok) {
    if (outcome.reason === "unauthenticated") redirect("/login");
    // Input was already validated to a uuid and a boolean, so neither
    // classification can be an input problem here. `conflict` is the DAL's own
    // balance preflight; `invalid_input` is the same rule arriving from
    // `accounts_guard_update()` as a check violation, when a transaction landed
    // between the preflight and the write.
    if (outcome.reason === "conflict" || outcome.reason === "invalid_input") {
      return failed(ARCHIVE_NEEDS_ZERO_BALANCE);
    }
    return outcome.state;
  }

  revalidateAccountRoutes();
  return succeeded();
}
