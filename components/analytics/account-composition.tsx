import { percentage, sumCents } from "@/lib/finance/money";
import { formatCents } from "@/lib/format/currency";
import { formatPercent } from "@/lib/format/percent";
import type { Cents } from "@/lib/types";

/** Fixed-order categorical ramp already defined in app/globals.css — never generated/cycled. */
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

interface CompositionRow {
  id: string;
  name: string;
  amountCents: Cents;
}

export function AccountComposition({ rows }: { rows: CompositionRow[] }) {
  const total = sumCents(rows.map((r) => r.amountCents));
  const shares = rows.map((row) => percentage(row.amountCents, total) ?? 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {rows.map((row, i) => (
          <div
            key={row.id}
            style={{ width: `${shares[i]}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {rows.map((row, i) => (
          <li key={row.id} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-foreground">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                aria-hidden="true"
              />
              {row.name}
            </span>
            <span className="text-muted-foreground">
              {formatCents(row.amountCents)} · {formatPercent(shares[i])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
