import { KindBadge } from "@/components/transactions/kind-badge";
import type { TransactionRow } from "@/components/transactions/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCentsSigned } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import { cn } from "@/lib/utils";

/** Desktop view. Hidden below md — see TransactionList for the mobile equivalent. */
export function TransactionTable({ rows }: { rows: TransactionRow[] }) {
  return (
    <div className="hidden rounded-lg border border-border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const isMovement = row.kind === "transfer" || row.kind === "credit_card_payment";
            return (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatCalendarDate(row.date)}
                </TableCell>
                <TableCell className={cn("font-medium", isMovement && "text-muted-foreground")}>
                  {row.merchant}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.categoryName ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.accountName}</TableCell>
                <TableCell>
                  <KindBadge kind={row.kind} />
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-medium whitespace-nowrap",
                    isMovement
                      ? "text-muted-foreground"
                      : row.amountCents < 0
                        ? "text-destructive"
                        : "text-foreground"
                  )}
                >
                  {formatCentsSigned(row.amountCents)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
