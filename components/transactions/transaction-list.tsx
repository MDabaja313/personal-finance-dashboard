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
import { formatCentsSigned } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import type { CalendarDate } from "@/lib/types";
import { isMovementKind } from "@/lib/types/enums";
import { cn } from "@/lib/utils";

/** Mobile view. Hidden at md+ — see TransactionTable for the desktop equivalent. */
export function TransactionList({
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
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => {
        const isNonEconomic = isMovementKind(row.kind) || row.kind === "adjustment";
        return (
          <li key={row.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className={cn(
                    "truncate text-sm font-medium",
                    isNonEconomic ? "text-muted-foreground" : "text-foreground"
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
                  isNonEconomic
                    ? "text-muted-foreground"
                    : row.amountCents < 0
                      ? "text-destructive"
                      : "text-foreground"
                )}
              >
                {formatCentsSigned(row.amountCents)}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <KindBadge kind={row.kind} />
              <TransactionRowActions
                row={row}
                actions={actions}
                movementActions={movementActions}
                accounts={accounts}
                movementAccounts={movementAccounts}
                categories={categories}
                today={today}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
