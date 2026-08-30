import { netWorth, totalAssets, totalLiabilities } from "@/lib/finance/accounts";
import { monthlyCashFlow, monthlyIncome, monthlySpending, savingsRate } from "@/lib/finance/transactions";
import type { Account, Cents, MonthKey, NetWorthSnapshot, Transaction } from "@/lib/types";

export interface MonthlyTotal {
  month: MonthKey;
  incomeCents: Cents;
  spendingCents: Cents;
  cashFlowCents: Cents;
  savingsRate: number | null;
}

/**
 * One row per requested month, in the given order — a month with no
 * transactions still appears, with zeroed totals, rather than being
 * silently dropped from a trend chart.
 */
export function monthlyTotals(
  transactions: readonly Transaction[],
  months: readonly MonthKey[]
): MonthlyTotal[] {
  return months.map((month) => ({
    month,
    incomeCents: monthlyIncome(transactions, month),
    spendingCents: monthlySpending(transactions, month),
    cashFlowCents: monthlyCashFlow(transactions, month),
    savingsRate: savingsRate(transactions, month),
  }));
}

export type SnapshotHealthStatus = "healthy" | "stale";

export interface SnapshotHealth {
  status: SnapshotHealthStatus;
  /** The owner's current, authoritative totals — computed the same way every other live figure in the app is. */
  liveAssetsCents: Cents;
  liveLiabilitiesCents: Cents;
  liveNetWorthCents: Cents;
}

/**
 * Compares the current month's stored net-worth snapshot against the
 * owner's live derived totals, so a stale point on the trend chart can be
 * flagged rather than silently trusted.
 *
 * CP5 left two Phase 4 sign guards in `private.write_net_worth_snapshot`
 * (aggregate assets below zero, aggregate liabilities above zero
 * internally) — both reachable through ordinary writes. When either fires,
 * the ledger write still commits and live balances stay correct, but the
 * refresh raises before writing, and the current month's stored row is left
 * byte for byte unchanged. This is the read-side counterpart: it never
 * re-derives the sign-guard condition itself, only notices that the stored
 * row and the live totals disagree (or that no current-month row exists at
 * all).
 *
 * `totalAssets`/`totalLiabilities`/`netWorth` (`lib/finance/accounts.ts`)
 * remain the one authority for live totals — this does not duplicate that
 * math, only compares against it.
 *
 * Only ever meaningful for the *current* month. A historical snapshot is a
 * frozen fact about a month that already closed and is never compared
 * against today's balances — callers must not pass anything but the
 * owner's current `MonthKey`.
 */
export function snapshotHealth(
  accounts: readonly Account[],
  history: readonly NetWorthSnapshot[],
  currentMonth: MonthKey
): SnapshotHealth {
  const liveAssetsCents = totalAssets(accounts);
  const liveLiabilitiesCents = totalLiabilities(accounts);
  const liveNetWorthCents = netWorth(accounts);

  const current = history.find((snapshot) => snapshot.month === currentMonth);

  const isHealthy =
    current !== undefined &&
    current.assetsCents === liveAssetsCents &&
    current.liabilitiesCents === liveLiabilitiesCents &&
    current.netWorthCents === liveNetWorthCents;

  return {
    status: isHealthy ? "healthy" : "stale",
    liveAssetsCents,
    liveLiabilitiesCents,
    liveNetWorthCents,
  };
}
