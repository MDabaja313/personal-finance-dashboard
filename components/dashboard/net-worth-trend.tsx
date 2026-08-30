import { NetWorthChart } from "@/components/analytics/net-worth-chart";
import { SnapshotStaleNotice } from "@/components/shared/snapshot-stale-notice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface NetWorthTrendProps {
  data: { label: string; netWorthCents: number }[];
  /** From `snapshotHealth()` — true when the current month's stored snapshot is missing or disagrees with live balances. */
  stale?: boolean;
}

export function NetWorthTrend({ data, stale = false }: NetWorthTrendProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Net Worth Trend</CardTitle>
      </CardHeader>
      <CardContent>
        {stale && <SnapshotStaleNotice />}
        <NetWorthChart data={data} />
      </CardContent>
    </Card>
  );
}
