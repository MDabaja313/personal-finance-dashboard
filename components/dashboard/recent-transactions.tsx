import Link from "next/link";
import type { TransactionDisplayRow } from "@/components/transactions/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCentsSigned } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import { isMovementKind } from "@/lib/types/enums";
import { cn } from "@/lib/utils";

export function RecentTransactions({ rows }: { rows: TransactionDisplayRow[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Recent Transactions</CardTitle>
        <Link href="/transactions" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          rows.map((row, index) => {
            // Movement legs and adjustments alike: neither is spending or
            // income, so neither takes the amount's signed colouring.
            const isMovement = isMovementKind(row.kind) || row.kind === "adjustment";
            return (
              <div key={row.id}>
                {index > 0 && <Separator className="my-3" />}
                <div className="flex items-center justify-between gap-4">
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
                      {row.categoryName ? ` · ${row.categoryName}` : ""}
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
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
