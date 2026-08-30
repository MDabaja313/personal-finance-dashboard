import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toMonthlyPlan } from "@/lib/data/mappers";
import type { MonthlyPlanRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { dataIntegrity } from "@/lib/errors";
import type { MonthlyPlan, MonthKey } from "@/lib/types";

/**
 * Phase 8 CP2: reads `public.monthly_plans` — the owner's expected income for
 * one month.
 *
 * ## Why this returns `undefined` rather than a zeroed plan
 *
 * "Not set" and "expected zero" are different answers to the same question, and
 * the Monthly Plan summary renders them differently: the first as "—" with an
 * invitation to set one, the second as a real target every planned expense is
 * measured against. Defaulting an absent row to zero here would collapse the
 * distinction in the one layer that still has it, and every consumer would then
 * be reporting "you have allocated more than you expect to earn" to a person
 * who has simply not answered yet.
 *
 * ## Ordering
 *
 * There is none to state, and that is a property of the table rather than an
 * omission: `UNIQUE (user_id, period)` means this query matches at most one
 * row. More than one is a schema violation, not a list to sort, so it is
 * reported as `data_integrity` rather than resolved by picking a winner.
 */
const PLAN_COLUMNS = "id, period, expected_income_cents";

export async function getMonthlyPlan(period: MonthKey): Promise<MonthlyPlan | undefined> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("monthly_plans")
    .select(PLAN_COLUMNS)
    .eq("user_id", ownerId)
    .eq("period", period);

  if (error) throw mapDbError(error, "the monthly plan");

  const rows = data as MonthlyPlanRow[];
  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    // `UNIQUE (user_id, period)` makes this unreachable. It is checked anyway
    // because the alternative — silently taking `rows[0]` — would present one
    // of two contradictory targets as the answer, and the ordering of that
    // choice would be the database's whim.
    throw dataIntegrity("More than one monthly plan exists for that period.");
  }

  return toMonthlyPlan(rows[0]);
}
