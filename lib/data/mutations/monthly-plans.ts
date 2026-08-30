import "server-only";

import { mapWriteError } from "@/lib/data/db-errors";
import { centsFrom } from "@/lib/data/mappers";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { conflict } from "@/lib/errors";
import type { Cents, MonthKey } from "@/lib/types";
import type { MonthlyPlanInput } from "@/lib/validation/monthly-plans";

/**
 * The write half of the monthly-plan DAL — expected income, and nothing else.
 *
 * ## The rules this module keeps, unchanged from CP2–CP7
 *
 * **The owner is never a parameter.** Every function calls `getOwnerId()` and
 * uses what it returns. **Every statement carries an explicit owner predicate**
 * on top of RLS (`monthly_plans_insert_own`/`_update_own`/`_delete_own` are the
 * enforced floor; the `.eq("user_id", ownerId)` here is defense in depth).
 * **No navigation, no revalidation** — both fenced out of
 * `lib/data/mutations/**` by ESLint. **Errors are typed, never raw.**
 *
 * ## What this module deliberately cannot do
 *
 * **It cannot touch a ledger row, a balance or a snapshot.** It names exactly
 * one relation, `monthly_plans`, and that relation is referenced by nothing:
 * no account, no transaction, no budget, no goal and no net-worth snapshot
 * reads it, and `private.write_net_worth_snapshot` has no grant on it and no
 * awareness of it. An expected figure cannot move net worth because there is no
 * path along which it could.
 *
 * **It cannot record income.** Actual income is `monthlyIncome()` over
 * `kind = 'income'` transactions, which this table cannot reach and this module
 * never writes.
 *
 * **It cannot address another month.** `period` arrives from the Server Action,
 * derived from the owner's own calendar day, and is INSERT-only at the grant
 * layer — so an existing plan's month can never be rewritten in place.
 *
 * ## Why "set" is an upsert written out rather than `.upsert()`
 *
 * PostgREST's `upsert` needs an `ON CONFLICT` target, and the two unique
 * constraints on this table — the primary key and `(user_id, period)` — mean a
 * 23505 has two possible causes. Resolving that by naming one constraint would
 * make the other collision silently fail. So the collision is disambiguated the
 * way `lib/data/mutations/budgets.ts` disambiguates its own three-way case:
 * read back, compare, and decide. It also keeps this module's statements
 * ordinary INSERT/UPDATE/DELETE, which is what makes the column-scoped grants
 * meaningful — an upsert that fell back to UPDATE would need the insert grant's
 * columns to be updatable, and `period` deliberately is not.
 */

/** The columns a read-back needs to compare a stored row against a payload. */
const OWN_ROW_COLUMNS = "id, user_id, period, expected_income_cents";

interface MonthlyPlanQueryRow {
  id: string;
  user_id: string;
  period: string;
  expected_income_cents: number | string;
}

/** One stored plan, normalized for comparison. Never returned to a caller. */
interface StoredPlan {
  readonly id: string;
  readonly userId: string;
  readonly period: MonthKey;
  readonly expectedIncomeCents: Cents;
}

function toStoredPlan(row: MonthlyPlanQueryRow): StoredPlan {
  return {
    id: row.id,
    userId: row.user_id,
    period: row.period,
    expectedIncomeCents: centsFrom(row.expected_income_cents, "monthly_plans.expected_income_cents"),
  };
}

/** The owned plan for this exact period, or `undefined`. */
async function readOwnPlanForPeriod(period: MonthKey): Promise<StoredPlan | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("monthly_plans")
    .select(OWN_ROW_COLUMNS)
    .eq("user_id", ownerId)
    .eq("period", period);

  if (error) throw mapWriteError(error, "the monthly plan");

  const rows = data as MonthlyPlanQueryRow[];
  if (rows.length !== 1) return undefined;
  return toStoredPlan(rows[0]);
}

/** The owned plan behind `planId`, or `undefined`. */
async function readOwnPlanById(planId: string): Promise<StoredPlan | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("monthly_plans")
    .select(OWN_ROW_COLUMNS)
    .eq("id", planId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the monthly plan");

  const rows = data as MonthlyPlanQueryRow[];
  if (rows.length !== 1) return undefined;
  return toStoredPlan(rows[0]);
}

export interface MonthlyPlanWriteResult {
  /** True when the stored figure already equalled the submitted one — nothing was written. */
  readonly deduplicated: boolean;
}

/**
 * Sets the owner's expected income for one month, creating the plan or
 * updating it.
 *
 * ## The three-way disambiguation of a 23505
 *
 * A plan already exists for the month → plain UPDATE of the one editable
 * column, and no id is involved at all. Nothing exists → INSERT at the
 * caller-minted key. A collision on that INSERT has three possible causes and
 * each gets its own outcome:
 *
 * 1. **The id is ours and the stored row already matches.** A successful retry
 *    — nothing is written, and the caller is told so.
 * 2. **The id is ours but the stored row differs.** The form was resubmitted
 *    without a fresh key against a plan that has since moved. A `conflict`.
 * 3. **The id is not ours.** The read-back finds nothing (RLS hides another
 *    owner's row exactly as it hides a row that never existed), which means the
 *    collision came from `(user_id, period)` instead — a plan was created for
 *    this month between the read above and the insert. That is a race with
 *    ourselves, not a refusal: the natural-key row is re-read and updated, so a
 *    double-submitted "set" lands on the value the person asked for rather than
 *    on an error they cannot act on.
 *
 * Never a blind "any 23505 is success".
 */
export async function setMonthlyPlan(input: MonthlyPlanInput): Promise<MonthlyPlanWriteResult> {
  const ownerId = await getOwnerId();

  const existing = await readOwnPlanForPeriod(input.period);
  if (existing !== undefined) {
    if (existing.expectedIncomeCents === input.expectedIncomeCents) {
      return { deduplicated: true };
    }
    await updateExpectedIncome(existing.id, input.expectedIncomeCents);
    return { deduplicated: false };
  }

  const supabase = await getDataClient();

  const { error } = await supabase.from("monthly_plans").insert({
    id: input.id,
    user_id: ownerId,
    period: input.period,
    expected_income_cents: input.expectedIncomeCents,
  });

  if (error === null) return { deduplicated: false };

  const mapped = mapWriteError(error, "the monthly plan");
  if (mapped.code !== "conflict") throw mapped;

  const byId = await readOwnPlanById(input.id);
  if (byId !== undefined) {
    if (byId.period === input.period && byId.expectedIncomeCents === input.expectedIncomeCents) {
      return { deduplicated: true };
    }
    throw conflict("A different monthly plan was already saved with that submission.");
  }

  // Case 3: the natural key won a race. Settle on what was asked for.
  const raced = await readOwnPlanForPeriod(input.period);
  if (raced === undefined) throw mapped;
  if (raced.expectedIncomeCents === input.expectedIncomeCents) return { deduplicated: true };

  await updateExpectedIncome(raced.id, input.expectedIncomeCents);
  return { deduplicated: false };
}

/**
 * The one editable column, on one owned row.
 *
 * `period` and `user_id` are absent from the payload *and* from the UPDATE
 * grant, so neither can move: a plan is for the month it was created for, and
 * getting the month wrong means writing that month's own row.
 */
async function updateExpectedIncome(planId: string, expectedIncomeCents: Cents): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { error } = await supabase
    .from("monthly_plans")
    .update({ expected_income_cents: expectedIncomeCents })
    .eq("id", planId)
    .eq("user_id", ownerId);

  if (error) throw mapWriteError(error, "the monthly plan");
}

/**
 * Clears the owner's plan for one month — back to "not set".
 *
 * A hard delete, which is acceptable here for the reason it is acceptable for a
 * budget: a plan is planning metadata, not ledger history, so removing one
 * destroys nothing that any figure was derived from. It exists because "not
 * set" is a genuinely different state from "expected zero" and there would
 * otherwise be no way back to it.
 *
 * Addressed by owner and period rather than by a row id, so this operation has
 * no addressable target a caller could aim elsewhere. Clearing a month that has
 * no plan is a silent success: the requested state is the state.
 */
export async function clearMonthlyPlan(period: MonthKey): Promise<void> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { error } = await supabase
    .from("monthly_plans")
    .delete()
    .eq("user_id", ownerId)
    .eq("period", period);

  if (error) throw mapWriteError(error, "the monthly plan");
}
