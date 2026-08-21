import Link from "next/link";
import { Meter } from "@/components/shared/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BudgetStatus } from "@/lib/finance/budgets";
import { formatCents } from "@/lib/format/currency";

interface BudgetStatusSectionProps {
  statuses: { status: BudgetStatus; categoryName: string }[];
}

export function BudgetStatusSection({ statuses }: BudgetStatusSectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Budget Status</CardTitle>
        <Link href="/budgets" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {statuses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No budgets set for this month.</p>
        ) : (
          statuses.map(({ status, categoryName }) => (
            <Meter
              key={status.budget.id}
              label={categoryName}
              value={status.utilization ?? 0}
              valueLabel={`${formatCents(status.spentCents)} of ${formatCents(status.budget.limitCents)}`}
              status={status.isOverBudget ? "over" : "default"}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
