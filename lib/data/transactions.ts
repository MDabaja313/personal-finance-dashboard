import "server-only";

import { mockTransactions } from "@/lib/mock/fixtures";
import type { Transaction } from "@/lib/types";

/**
 * Phase 0/1: reads mock fixtures. Phase 4 swaps this body for a Supabase
 * query — the signature (and every caller) stays the same.
 */
export async function getTransactions(): Promise<Transaction[]> {
  return [...mockTransactions];
}

export async function getRecentTransactions(limit: number): Promise<Transaction[]> {
  return [...mockTransactions]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}
