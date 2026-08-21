import { KindBadge } from "@/components/transactions/kind-badge";
import type { TransactionRow } from "@/components/transactions/types";
import { formatCentsSigned } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import { cn } from "@/lib/utils";

/** Mobile view. Hidden at md+ — see TransactionTable for the desktop equivalent. */
export function TransactionList({ rows }: { rows: TransactionRow[] }) {
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => {
        const isMovement = row.kind === "transfer" || row.kind === "credit_card_payment";
        return (
          <li key={row.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className={cn(
                    "truncate text-sm font-medium",
                    isMovement ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {row.merchant}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCalendarDate(row.date)}
                  {row.categoryName ? ` · ${row.categoryName}` : ""} · {row.accountName}
                </p>
              </div>
              <p
                className={cn(
                  "shrink-0 text-sm font-semibold",
                  isMovement
                    ? "text-muted-foreground"
                    : row.amountCents < 0
                      ? "text-destructive"
                      : "text-foreground"
                )}
              >
                {formatCentsSigned(row.amountCents)}
              </p>
            </div>
            <div className="mt-2">
              <KindBadge kind={row.kind} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
