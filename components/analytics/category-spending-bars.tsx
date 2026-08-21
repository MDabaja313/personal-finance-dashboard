import { formatCents } from "@/lib/format/currency";
import type { Cents } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CategoryBarRow {
  categoryId: string;
  categoryName: string;
  amountCents: Cents;
}

/** Simple CSS ranked bars — no chart library needed for a magnitude comparison like this. */
export function CategorySpendingBars({ rows }: { rows: CategoryBarRow[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.amountCents)));

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const widthPct = Math.min(100, (Math.abs(row.amountCents) / max) * 100);
        return (
          <div key={row.categoryId} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">{row.categoryName}</span>
              <span className={cn("text-muted-foreground", row.amountCents < 0 && "text-foreground")}>
                {formatCents(row.amountCents)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${widthPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
