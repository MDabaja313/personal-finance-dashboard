import { toCents, type NetWorthSnapshot } from "@/lib/types";

/**
 * Explicit monthly snapshots rather than derived from transactions — a
 * derived series would need a complete ledger back to account opening,
 * where any gap silently corrupts every point on the trend.
 *
 * The August snapshot is a required coherence invariant: it must equal the
 * current (non-archived) account totals under this same convention —
 * assetsCents positive, liabilitiesCents a positive magnitude,
 * netWorthCents = assetsCents - liabilitiesCents. See
 * lib/mock/index.test.ts.
 */
export const mockNetWorthHistory: readonly NetWorthSnapshot[] = Object.freeze([
  { month: "2026-03", assetsCents: toCents(11500000), liabilitiesCents: toCents(1650000), netWorthCents: toCents(9850000) },
  { month: "2026-04", assetsCents: toCents(11700000), liabilitiesCents: toCents(1630000), netWorthCents: toCents(10070000) },
  { month: "2026-05", assetsCents: toCents(11850000), liabilitiesCents: toCents(1610000), netWorthCents: toCents(10240000) },
  { month: "2026-06", assetsCents: toCents(11980000), liabilitiesCents: toCents(1590000), netWorthCents: toCents(10390000) },
  { month: "2026-07", assetsCents: toCents(12080000), liabilitiesCents: toCents(1575000), netWorthCents: toCents(10505000) },
  { month: "2026-08", assetsCents: toCents(12168230), liabilitiesCents: toCents(1560450), netWorthCents: toCents(10607780) },
]);
