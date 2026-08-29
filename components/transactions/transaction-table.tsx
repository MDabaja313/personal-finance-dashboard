import type {
  MovementAccountOption,
  MovementMutationActions,
} from "@/components/movements/types";
import { KindBadge } from "@/components/transactions/kind-badge";
import { TransactionRowActions } from "@/components/transactions/transaction-row-actions";
import type {
  AccountOption,
  CategoryOption,
  TransactionMutationActions,
  TransactionRow,
} from "@/components/transactions/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCentsSigned } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate } from "@/lib/types";
import { isMovementKind } from "@/lib/types/enums";
import { cn } from "@/lib/utils";

/**
 * Desktop view. Hidden below md — see TransactionList for the mobile
 * equivalent.
 *
 * Still a Server Component: only the per-row controls are interactive, and they
 * are their own client island. The rows themselves, including movement legs and
 * adjustments, render exactly as they always have.
 */
export function TransactionTable({
  rows,
  actions,
  movementActions,
  accounts,
  movementAccounts,
  categories,
  today,
}: {
  rows: TransactionRow[];
  actions: TransactionMutationActions;
  movementActions: MovementMutationActions;
  accounts: readonly AccountOption[];
  movementAccounts: readonly MovementAccountOption[];
  categories: readonly CategoryOption[];
  today: CalendarDate;
}) {
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
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const isNonEconomic = isMovementKind(row.kind) || row.kind === "adjustment";
            return (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatCalendarDate(row.date)}
                </TableCell>
                <TableCell className={cn("font-medium", isNonEconomic && "text-muted-foreground")}>
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
                    isNonEconomic
                      ? "text-muted-foreground"
                      : row.amountCents < 0
                        ? "text-destructive"
                        : "text-foreground"
                  )}
                >
                  {formatCentsSigned(row.amountCents)}
                </TableCell>
                <TableCell className="text-right">
                  <TransactionRowActions
                    row={row}
                    actions={actions}
                    movementActions={movementActions}
                    accounts={accounts}
                    movementAccounts={movementAccounts}
                    categories={categories}
                    today={today}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
