import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BudgetStatus } from "@/lib/finance/budgets";
import { formatCents } from "@/lib/format/currency";
import { toCents } from "@/lib/types";
import { cn } from "@/lib/utils";

export function BudgetCard({ status, categoryName }: { status: BudgetStatus; categoryName: string }) {
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
      </CardContent>
    </Card>
  );
}
