import "server-only";

import { mapDbError } from "@/lib/data/db-errors";
import { toAccount } from "@/lib/data/mappers";
import type { AccountBalanceRow } from "@/lib/data/rows";
import { getDataClient, getOwnerId } from "@/lib/data/supabase";
import type { Account } from "@/lib/types";

/**
 * Phase 6 Checkpoint 2: reads `public.account_balances`, the
 * `security_invoker` view whose `balance_cents` is derived
 * (`opening_balance_cents + SUM(ledger)`) — the base `accounts` table has no
 * usable balance column. Archived accounts are included; the `/accounts`
 * page groups them itself.
 *
 * `user_id = ownerId` is applied explicitly even though the view's own RLS
 * (through the base tables, since the view is `security_invoker`) already
 * scopes it — defense in depth, per CLAUDE.md.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getAccounts(): Promise<Account[]> {
  const ownerId = await getOwnerId();
  const supabase = await getDataClient();

  const { data, error } = await supabase
    .from("account_balances")
    .select(
      "id, name, institution, type, is_archived, balance_cents, credit_limit_cents, interest_rate_bps"
    )
    .eq("user_id", ownerId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw mapDbError(error, "accounts");

  return (data as AccountBalanceRow[]).map(toAccount);
}
