import { AccountCardActions } from "@/components/accounts/account-card-actions";
import type { AccountMutationActions } from "@/components/accounts/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { availableCredit } from "@/lib/finance/accounts";
import { formatCents } from "@/lib/format/currency";
import type { Account, AccountType, CalendarDate } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit Card",
  investment: "Investment",
  loan: "Loan",
};

function formatInterestRate(bps: number): string {
  return `${(bps / 100).toFixed(2)}% APR`;
}

/**
 * `actions` is optional so the card stays usable as a pure display component.
 * `/accounts` is the management surface and passes them; anywhere else that
 * renders an account can omit them and get read-only output.
 *
 * `today` travels with them, and only with them: it is the reconcile form's
 * date default and ceiling, so it is needed exactly when the controls are
 * rendered. The route resolves it once (`getToday()`, from the owner's
 * `profiles.timezone`) rather than each card reading a clock — a page that
 * straddled midnight would otherwise render two different "today"s.
 */
export function AccountCard({
  account,
  actions,
  today,
}: {
  account: Account;
  actions?: AccountMutationActions;
  today?: CalendarDate;
}) {
  const credit = availableCredit(account);

  return (
    <Card className={cn(account.isArchived && "opacity-60")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{account.name}</span>
          <Badge variant="outline" className="shrink-0">
            {ACCOUNT_TYPE_LABEL[account.type]}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{account.institution}</p>
        <p
          className={cn(
            "text-xl font-semibold",
            account.balanceCents < 0 && "text-destructive"
          )}
        >
          {formatCents(account.balanceCents)}
        </p>
        {account.creditLimitCents !== undefined && (
          <p className="text-xs text-muted-foreground">
            Limit {formatCents(account.creditLimitCents)}
            {credit !== null && <> · {formatCents(credit)} available</>}
          </p>
        )}
        {account.interestRateBps !== undefined && (
          <p className="text-xs text-muted-foreground">
            {formatInterestRate(account.interestRateBps)}
          </p>
        )}
        {actions && today !== undefined && (
          <AccountCardActions account={account} actions={actions} today={today} />
        )}
      </CardContent>
    </Card>
  );
}
