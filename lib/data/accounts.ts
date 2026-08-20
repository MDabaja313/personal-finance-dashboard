import "server-only";

import { mockAccounts } from "@/lib/mock/fixtures";
import type { Account } from "@/lib/types";

/**
 * Phase 0/1: reads mock fixtures. Phase 4 swaps this body for a Supabase
 * query — the signature (and every caller) stays the same.
 */
export async function getAccounts(): Promise<Account[]> {
  return [...mockAccounts];
}

export async function getAccountById(id: string): Promise<Account | null> {
  return mockAccounts.find((account) => account.id === id) ?? null;
}
