import { AccountCard } from "@/components/accounts/account-card";
import type { AccountMutationActions } from "@/components/accounts/types";
import { formatCents } from "@/lib/format/currency";
import type { Account, Cents } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AccountGroupProps {
  title: string;
  accounts: Account[];
  subtotal?: Cents;
  subtotalTone?: "default" | "negative";
  /** Passed straight through to each card; omit for a read-only group. */
  actions?: AccountMutationActions;
}

export function AccountGroup({
  title,
  accounts,
  subtotal,
  subtotalTone = "default",
  actions,
}: AccountGroupProps) {
  if (accounts.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {subtotal !== undefined && (
          <span
            className={cn(
              "text-sm font-semibold text-foreground",
              subtotalTone === "negative" && "text-destructive"
            )}
          >
            {formatCents(subtotal)}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((account) => (
          <AccountCard key={account.id} account={account} actions={actions} />
        ))}
      </div>
    </section>
  );
}
