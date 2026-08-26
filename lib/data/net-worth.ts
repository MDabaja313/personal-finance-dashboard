import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toNetWorthSnapshot } from "@/lib/data/mappers";
import type { NetWorthSnapshotRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import { dataIntegrity } from "@/lib/errors";
import type { NetWorthSnapshot } from "@/lib/types";

/**
 * Most recent `months` snapshots, oldest first. Omit for the full history.
 *
 * Phase 6 Checkpoint 2: reads `public.net_worth_snapshots` ordered
 * `month DESC` (most recent first, so a `LIMIT` — applied only for a
 * positive `months` — keeps the most recent N rows), then reverses the
 * result so the return value stays chronological (ASC), which is what every
 * caller and chart expects.
 *
 * `months === 0` returns the full history, not an empty list: `slice(-0)` is
 * `slice(0)` in the fixture oracle, and this implementation preserves that
 * contract by only applying `LIMIT` for a strictly positive `months`. A
 * negative or non-integer `months` is a caller bug, not a value to silently
 * coerce — it fails as `data_integrity`.
 */
export async function getNetWorthHistory(months?: number): Promise<NetWorthSnapshot[]> {
  if (months !== undefined && (!Number.isSafeInteger(months) || months < 0)) {
    throw dataIntegrity("Invalid months value for net worth history.");
  }

  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  let query = supabase
    .from("net_worth_snapshots")
    .select("month, assets_cents, liabilities_cents, net_worth_cents")
    .eq("user_id", ownerId)
    .order("month", { ascending: false });

  if (months !== undefined && months > 0) {
    query = query.limit(months);
  }

  const { data, error } = await query;

  if (error) throw mapDbError(error, "net worth history");

  return (data as NetWorthSnapshotRow[]).map(toNetWorthSnapshot).reverse();
}
