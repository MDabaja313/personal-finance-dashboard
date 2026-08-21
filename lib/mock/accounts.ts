import { toCents, type Account } from "@/lib/types";

/**
 * Signed balances: assets positive, liabilities (credit/loan) negative.
 * Archived accounts are excluded from net-worth totals by lib/finance/accounts.
 */
export const mockAccounts: readonly Account[] = Object.freeze([
  {
    id: "acc-checking",
    name: "Everyday Checking",
    institution: "Horizon Bank",
    type: "checking",
    balanceCents: toCents(423155), // $4,231.55
    isArchived: false,
  },
  {
    id: "acc-savings",
    name: "High-Yield Savings",
    institution: "Horizon Bank",
    type: "savings",
    balanceCents: toCents(8500000), // $85,000.00 (large value)
    isArchived: false,
  },
  {
    id: "acc-cash",
    name: "Cash Wallet",
    institution: "Personal",
    type: "cash",
    balanceCents: toCents(0), // $0.00 (zero balance)
    isArchived: false,
  },
  {
    id: "acc-credit",
    name: "Rewards Credit Card",
    institution: "Apex Card Co.",
    type: "credit",
    balanceCents: toCents(-128450), // -$1,284.50 (liability)
    creditLimitCents: toCents(500000), // $5,000.00
    interestRateBps: 2399, // 23.99%
    isArchived: false,
  },
  {
    id: "acc-investment",
    name: "Brokerage Account",
    institution: "Meridian Investments",
    type: "investment",
    balanceCents: toCents(3245075), // $32,450.75
    isArchived: false,
  },
  {
    id: "acc-loan",
    name: "Auto Loan",
    institution: "Horizon Bank",
    type: "loan",
    balanceCents: toCents(-1432000), // -$14,320.00 (liability)
    interestRateBps: 649, // 6.49%
    isArchived: false,
  },
  {
    id: "acc-old-checking",
    name: "Old Checking (Closed)",
    institution: "Legacy Bank",
    type: "checking",
    balanceCents: toCents(1234), // $12.34 leftover balance before closure
    isArchived: true,
  },
]);
