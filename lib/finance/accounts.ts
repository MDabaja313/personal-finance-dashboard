import { sumCents } from "@/lib/finance/money";
import { toCents, type Account, type AccountType, type Cents } from "@/lib/types";
import { isLiabilityAccountType } from "@/lib/types/enums";

export type AccountKind = "asset" | "liability";

/**
 * The list itself moved to `lib/types/enums.ts` in Phase 7 CP5: reconciliation
 * validation and the reconcile form both have to know which types store a
 * negative balance, and neither may import `lib/finance/**`. This stays the
 * display layer's way of asking the question, and no longer holds a second
 * copy of the answer.
 */
export function accountKind(type: AccountType): AccountKind {
  return isLiabilityAccountType(type) ? "liability" : "asset";
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
