import { getAccounts } from "@/lib/data/accounts";
import { getRecentTransactions } from "@/lib/data/transactions";
import { formatCents } from "@/lib/format/currency";
import { formatCalendarDate } from "@/lib/format/date";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default async function DashboardPage() {
  const [accounts, transactions] = await Promise.all([
    getAccounts(),
    getRecentTransactions(5),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold text-foreground">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Overview of your accounts and recent activity.
        </p>
      </div>

      <section aria-labelledby="accounts-heading" className="flex flex-col gap-3">
        <h2 id="accounts-heading" className="text-sm font-medium text-muted-foreground">
          Accounts
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{account.name}</span>
                  <span className="text-xs font-normal capitalize text-muted-foreground">
                    {account.type}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={cn(
                    "text-lg font-semibold",
                    account.balanceCents < 0 && "text-destructive"
                  )}
                >
                  {formatCents(account.balanceCents)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="transactions-heading">
        <Card>
          <CardHeader>
            <CardTitle id="transactions-heading">Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            {transactions.map((transaction, index) => (
              <div key={transaction.id}>
                {index > 0 && <Separator className="my-3" />}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {transaction.description}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatCalendarDate(transaction.date)} · {transaction.category}
                    </p>
                  </div>
                  <p
                    className={cn(
                      "shrink-0 text-sm font-semibold",
                      transaction.amountCents < 0
                        ? "text-destructive"
                        : "text-foreground"
                    )}
                  >
                    {transaction.amountCents > 0 ? "+" : ""}
                    {formatCents(transaction.amountCents)}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
