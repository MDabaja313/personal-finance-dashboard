import "server-only";

import * as oracle from "@/lib/mock/dal";
import type { Account } from "@/lib/types";

/**
 * Phase 6 Checkpoint 1: delegates to the extracted fixture oracle
 * (`lib/mock/dal.ts`), which is the same code this function used to contain.
 * Checkpoint 2 replaces the body with an `account_balances` view read; the
 * signature, the ordering contract, and every caller stay the same.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getAccounts(): Promise<Account[]> {
  return oracle.getAccounts();
}
