import { sumCents } from "@/lib/finance/money";
import { toCents, type Account, type AccountType, type Cents } from "@/lib/types";

export type AccountKind = "asset" | "liability";

const LIABILITY_TYPES: readonly AccountType[] = ["credit", "loan"];

export function accountKind(type: AccountType): AccountKind {
  return LIABILITY_TYPES.includes(type) ? "liability" : "asset";
}

function activeAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => !account.isArchived);
}

/** Positive sum of asset-type account balances. Archived accounts excluded. */
export function totalAssets(accounts: readonly Account[]): Cents {
  return sumCents(
    activeAccounts(accounts)
      .filter((account) => accountKind(account.type) === "asset")
      .map((account) => account.balanceCents)
  );
}

/** Positive magnitude of liability-type balances (which are stored negative). */
export function totalLiabilities(accounts: readonly Account[]): Cents {
  const signedSum = sumCents(
    activeAccounts(accounts)
      .filter((account) => accountKind(account.type) === "liability")
      .map((account) => account.balanceCents)
  );
  return toCents(-signedSum || 0); // avoid -0 when there are no liabilities
}

/** Sum of every active account's signed balance. Equals totalAssets - totalLiabilities. */
export function netWorth(accounts: readonly Account[]): Cents {
  return sumCents(activeAccounts(accounts).map((account) => account.balanceCents));
}

/** Remaining spending room on a credit account; null if it has no credit limit. */
export function availableCredit(account: Account): Cents | null {
  if (account.creditLimitCents === undefined) return null;
  return toCents(account.creditLimitCents + account.balanceCents);
}
