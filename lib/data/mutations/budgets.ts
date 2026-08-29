import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict, invalidInput, notFound } from "@/lib/errors";
import type { Cents, MonthKey } from "@/lib/types";
import type { BudgetCreateInput, BudgetUpdateInput } from "@/lib/validation/budgets";

/**
 * The write half of the budgets DAL.
 *
 * ## The rules this module keeps, unchanged from CP2–CP5
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()`
 * and uses what it returns. **Every statement carries an explicit owner
 * predicate** on top of RLS (`budgets_insert_own`/`_update_own`/`_delete_own`
 * are the enforced floor; the `.eq("user_id", ownerId)` here is defense in
 * depth). **No navigation, no revalidation** — both fenced out of
 * `lib/data/mutations/**` by ESLint. **Errors are typed, never raw** — every
 * failure goes through `mapWriteError`.
 *
 * ## Why the category preflight exists
 *
 * `createBudget` reads the category before it writes. That is not an
 * authorization check — RLS and `assert_budget_category_active_expense()`
 * are — it is an error-quality check: without it, budgeting an archived or
 * income category comes back as a bare SQLSTATE 23514 and reaches the
 * person as "Some of the information entered is not valid". The database
 * guard is not thereby redundant and must never be removed on the strength
 * of this preflight: `authenticated` holds a direct INSERT naming
 * `category_id`, and PostgREST is reachable from a browser with nothing but
 * a session token.
 *
 * ## Idempotency, and the three-way disambiguation of a 23505
 *
 * The create form mints one client-generated UUID per submission and posts
 * it as the row's `id`, exactly as CP3's transaction create does — a retry
 * therefore collides with itself on the primary key. But `budgets` carries
 * a *second* UNIQUE constraint, `(user_id, category_id, period)`, so a
 * 23505 here has three possible causes rather than CP3's two, and each gets
 * its own outcome:
 *
 * 1. **The id is ours, and the stored row matches the submission exactly.**
 *    A successful retry — nothing is written, and the caller is told so.
 * 2. **The id is ours, but the stored row differs.** The form was
 *    resubmitted without a fresh key. A `conflict`.
 * 3. **The id is not ours at all.** Read back finds nothing under that id
 *    (RLS hides a foreign owner's row identically to a row that never
 *    existed), which means the 23505 came from the natural-key constraint
 *    instead — this owner already has a budget for that category and
 *    period, under a *different* id. A `conflict` with its own message.
 *
 * Never a blind "any 23505 is success".
 */

/** The columns a read-back needs to compare a stored row against a payload. */
const OWN_ROW_COLUMNS = "id, user_id, category_id, period, limit_cents";

/** One stored budget, normalized for comparison. Never returned to a caller. */
interface StoredBudget {
  readonly id: string;
  readonly userId: string;
  readonly categoryId: string;
  readonly period: MonthKey;
  readonly limitCents: Cents;
}

interface BudgetQueryRow {
  id: string;
  user_id: string;
  category_id: string;
  period: string;
  limit_cents: number | string;
}

function toStoredBudget(row: BudgetQueryRow): StoredBudget {
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id,
    period: row.period,
    limitCents: centsFrom(row.limit_cents, "budgets.limit_cents"),
  };
}

/** The owned budget behind `budgetId`, or `undefined` — never a throw, see `createBudget`. */
async function readOwnBudget(budgetId: string): Promise<StoredBudget | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("budgets")
    .select(OWN_ROW_COLUMNS)
    .eq("id", budgetId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the budget");

  const rows = data as BudgetQueryRow[];
  if (rows.length !== 1) return undefined;
  return toStoredBudget(rows[0]);
}

/** The owned budget for this exact (category, period), or `undefined`. */
async function readOwnBudgetForPeriod(
  categoryId: string,
  period: MonthKey
): Promise<StoredBudget | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("budgets")
    .select(OWN_ROW_COLUMNS)
    .eq("category_id", categoryId)
    .eq("period", period)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the budget");

  const rows = data as BudgetQueryRow[];
  if (rows.length !== 1) return undefined;
  return toStoredBudget(rows[0]);
}

/**
 * Refuses a category that does not exist, is not the caller's, is archived,
 * or is not an expense category — the message layer in front of
 * `assert_budget_category_active_expense()`.
 */
async function assertCategoryUsableForBudget(categoryId: string): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("categories")
    .select("kind, is_archived")
    .eq("id", categoryId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the budget");

  const rows = data as { kind: string; is_archived: boolean }[];
  if (rows.length !== 1) throw notFound("That category does not exist.");
  if (rows[0].is_archived) {
    throw invalidInput("That category is archived. Unarchive it before budgeting it.");
  }
  if (rows[0].kind !== "expense") {
    throw invalidInput("Only expense categories can be budgeted.");
  }
}

export interface BudgetCreateResult {
  readonly id: string;
  /** True when the row was already there, byte-identical, under the same key. */
  readonly deduplicated: boolean;
}

/** Creates one budget at the caller-supplied idempotency key. See the module note. */
export async function createBudget(input: BudgetCreateInput): Promise<BudgetCreateResult> {
  const ownerId = await getOwnerId();
  await assertCategoryUsableForBudget(input.categoryId);

  const supabase = await getDataClient();

  const { error } = await supabase.from("budgets").insert({
    id: input.id,
    user_id: ownerId,
    category_id: input.categoryId,
    period: input.period,
    limit_cents: input.limitCents,
  });

  if (error === null) return { id: input.id, deduplicated: false };

  const mapped = mapWriteError(error, "the budget");
  if (mapped.code !== "conflict") throw mapped;

  const existing = await readOwnBudget(input.id);
  if (existing !== undefined) {
    if (
      existing.categoryId === input.categoryId &&
      existing.period === input.period &&
      existing.limitCents === input.limitCents
    ) {
      return { id: input.id, deduplicated: true };
    }
    throw conflict("A different budget was already saved with that submission.");
  }

  // Case 3: not our id. Distinguish "someone else's key" from "our own
  // natural-key collision under a different id" by checking for the latter
  // directly, rather than parsing the driver's constraint name.
  const collision = await readOwnBudgetForPeriod(input.categoryId, input.period);
  if (collision !== undefined) {
    throw conflict("A budget already exists for this category this month.");
  }

  throw mapped;
}

/**
 * Updates the limit on one owned budget. `category_id` and `period` are
 * absent from the payload and from the UPDATE grant — see
 * `lib/validation/budgets.ts` for why getting either wrong means delete and
 * recreate rather than an in-place edit.
 */
export async function updateBudget(input: BudgetUpdateInput): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnBudget(input.id);
  if (existing === undefined) throw notFound("That budget does not exist.");

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("budgets")
    .update({ limit_cents: input.limitCents })
    .eq("id", input.id)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the budget");
}

/**
 * Deletes one owned budget. A hard delete is acceptable here, unlike almost
 * every other table this application writes: a budget is planning
 * metadata, not ledger history, so nothing worth preserving is lost.
 */
export async function deleteBudget(budgetId: string): Promise<void> {
  const ownerId = await getOwnerId();

  const existing = await readOwnBudget(budgetId);
  if (existing === undefined) throw notFound("That budget does not exist.");

  const supabase = await getDataClient();

  const { error } = await supabase
    .from("budgets")
    .delete()
    .eq("id", budgetId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the budget");
}
