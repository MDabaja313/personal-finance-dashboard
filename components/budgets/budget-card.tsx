import { BudgetCardActions } from "@/components/budgets/budget-card-actions";
import type { BudgetMutationActions } from "@/components/budgets/types";
import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BudgetStatus } from "@/lib/finance/budgets";
import { formatCents } from "@/lib/format/currency";
import { toCents } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * `actions` is optional so this stays usable as a pure display component —
 * the dashboard's budget section renders one with none, `/budgets` renders
 * one with the full set. Existing calculations (`budgetStatus`) remain the
 * sole authority on spend, over-budget state, and utilisation; nothing here
 * recomputes any of it.
 */
export function BudgetCard({
  status,
  categoryName,
  actions,
}: {
  status: BudgetStatus;
  categoryName: string;
  actions?: BudgetMutationActions;
}) {
  const { budget, spentCents, remainingCents, utilization, isOverBudget } = status;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{categoryName}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Meter
          label="Spent"
          value={utilization ?? 0}
          valueLabel={`${formatCents(spentCents)} of ${formatCents(budget.limitCents)}`}
          status={isOverBudget ? "over" : "default"}
        />
        <p className={cn("text-xs", isOverBudget ? "text-destructive" : "text-muted-foreground")}>
          {isOverBudget
            ? `${formatCents(toCents(-remainingCents))} over budget`
            : `${formatCents(remainingCents)} remaining`}
        </p>
        {actions && <BudgetCardActions budget={budget} actions={actions} />}
      </CardContent>
    </Card>
  );
}
