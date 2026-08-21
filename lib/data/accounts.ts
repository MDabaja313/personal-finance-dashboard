import "server-only";

import { mockAccounts } from "@/lib/mock";
import type { Account } from "@/lib/types";

/**
 * Phase 0/1: reads mock fixtures. Phase 6 swaps this body for a Supabase
 * query — the signature (and every caller) stays the same.
 *
 * Ordering: `name ASC, id ASC` — see docs/database-schema.md.
 */
export async function getAccounts(): Promise<Account[]> {
  return [...mockAccounts].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}
