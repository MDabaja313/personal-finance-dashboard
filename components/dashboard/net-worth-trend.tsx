import { NetWorthChart } from "@/components/analytics/net-worth-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface NetWorthTrendProps {
  data: { label: string; netWorthCents: number }[];
}

export function NetWorthTrend({ data }: NetWorthTrendProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Net Worth Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <NetWorthChart data={data} />
      </CardContent>
    </Card>
  );
}
