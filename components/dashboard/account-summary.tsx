import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/format/currency";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AccountSummary({ accounts }: { accounts: Account[] }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Accounts</CardTitle>
        <Link href="/accounts" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-foreground">{account.name}</span>
            <span className={cn("font-medium", account.balanceCents < 0 && "text-destructive")}>
              {formatCents(account.balanceCents)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
