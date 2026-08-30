import { Badge } from "@/components/ui/badge";

/**
 * Shown beside the net-worth trend chart, on both /dashboard and /analytics,
 * exactly when `snapshotHealth()` (`lib/finance/trends.ts`) reports the
 * current month's stored snapshot as stale or missing. Deliberately
 * non-alarming and free of implementation detail: no SQLSTATE, no sign-guard
 * language, no account figures — see CLAUDE.md's CP8A section for why. Renders
 * nothing when the snapshot is healthy; callers own that condition.
 */
export function SnapshotStaleNotice() {
  return (
    <div className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
      <Badge variant="secondary" className="mt-0.5">
        Updating
      </Badge>
      <span>
        This month&apos;s trend point is out of date. Your live account balances and totals are
        still current.
      </span>
    </div>
  );
}
