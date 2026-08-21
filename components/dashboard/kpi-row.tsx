import { StatTile } from "@/components/shared/stat-tile";
import { formatCents } from "@/lib/format/currency";
import { formatPercent } from "@/lib/format/percent";
import type { Cents } from "@/lib/types";
import { cn } from "@/lib/utils";

interface KpiRowProps {
  netWorthCents: Cents;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  monthlyIncomeCents: Cents;
  monthlySpendingCents: Cents;
  cashFlowCents: Cents;
  savingsRate: number | null;
}

export function KpiRow(props: KpiRowProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Net Worth</p>
        <p className={cn("text-3xl font-semibold", props.netWorthCents < 0 && "text-destructive")}>
          {formatCents(props.netWorthCents)}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Assets" value={formatCents(props.totalAssetsCents)} />
        <StatTile label="Liabilities" value={formatCents(props.totalLiabilitiesCents)} tone="negative" />
        <StatTile label="Income" value={formatCents(props.monthlyIncomeCents)} />
        <StatTile label="Spending" value={formatCents(props.monthlySpendingCents)} />
        <StatTile
          label="Cash Flow"
          value={formatCents(props.cashFlowCents)}
          tone={props.cashFlowCents < 0 ? "negative" : "default"}
        />
        <StatTile label="Savings Rate" value={formatPercent(props.savingsRate)} />
      </div>
    </div>
  );
}
