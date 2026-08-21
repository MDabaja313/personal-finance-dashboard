import Link from "next/link";
import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoalProgress } from "@/lib/finance/goals";
import { formatCents } from "@/lib/format/currency";

export function GoalProgressSection({ progresses }: { progresses: GoalProgress[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Goal Progress</CardTitle>
        <Link href="/goals" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {progresses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No goals yet.</p>
        ) : (
          progresses.map((p) => (
            <Meter
              key={p.goal.id}
              label={p.goal.name}
              value={p.progress ?? 0}
              valueLabel={`${formatCents(p.goal.savedCents)} of ${formatCents(p.goal.targetCents)}`}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
