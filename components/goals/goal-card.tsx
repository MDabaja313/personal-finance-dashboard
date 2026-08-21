import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoalProgress } from "@/lib/finance/goals";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";

export function GoalCard({ progress }: { progress: GoalProgress }) {
  const { goal, remainingCents, progress: pct, isComplete, requiredMonthlyContributionCents } = progress;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{goal.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Meter
          label="Saved"
          value={pct ?? 0}
          valueLabel={`${formatCents(goal.savedCents)} of ${formatCents(goal.targetCents)}`}
        />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{isComplete ? "Goal reached" : `${formatCents(remainingCents)} remaining`}</span>
          {goal.targetDate && <span>Target {formatCalendarDate(goal.targetDate)}</span>}
          {requiredMonthlyContributionCents !== null && (
            <span>{formatCents(requiredMonthlyContributionCents)}/mo needed</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
