import { GoalCardActions } from "@/components/goals/goal-card-actions";
import type { GoalContributionRow, GoalMutationActions } from "@/components/goals/types";
import { Badge } from "@/components/ui/badge";
import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoalProgress } from "@/lib/finance/goals";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * `actions` is optional so this stays usable as a pure display component —
 * the dashboard's goal-progress section renders one with none, `/goals`
 * renders one with the full management set. Existing calculations
 * (`goalProgress()`) remain the sole authority on remaining amount,
 * completion, and the required monthly contribution.
 */
export function GoalCard({
  progress,
  isArchived = false,
  actions,
  today,
  contributions,
}: {
  progress: GoalProgress;
  isArchived?: boolean;
  actions?: GoalMutationActions;
  today?: CalendarDate;
  contributions?: readonly GoalContributionRow[];
}) {
  const { goal, remainingCents, progress: pct, isComplete, requiredMonthlyContributionCents } = progress;

  return (
    <Card className={cn(isArchived && "opacity-60")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{goal.name}</span>
          {isArchived && (
            <Badge variant="secondary" className="shrink-0">
              Archived
            </Badge>
          )}
        </CardTitle>
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
        {actions && today !== undefined && contributions !== undefined && (
          <GoalCardActions
            goal={goal}
            isArchived={isArchived}
            actions={actions}
            today={today}
            contributions={contributions}
          />
        )}
      </CardContent>
    </Card>
  );
}
