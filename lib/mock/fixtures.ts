import { toCents, type Account, type Transaction } from "@/lib/types";

/**
 * Deterministic, frozen fixture data for Phase 0/1 (no Supabase yet).
 * No Math.random(), no Date.now() — every value is hardcoded so
 * calculations and UI are reproducible and diffable.
 *
 * Deliberately includes: a negative balance (credit card), a zero balance
 * (cash), a large value (savings), a refund, two same-day transactions,
 * and a month-boundary pair (Jul 31 / Aug 1) to catch date shift bugs.
 */

export const mockAccounts: readonly Account[] = Object.freeze([
  {
    id: "acc-checking",
    name: "Everyday Checking",
    type: "checking",
    balanceCents: toCents(423155), // $4,231.55
  },
  {
    id: "acc-savings",
    name: "High-Yield Savings",
    type: "savings",
    balanceCents: toCents(8500000), // $85,000.00 (large value)
  },
  {
    id: "acc-credit",
    name: "Rewards Credit Card",
    type: "credit",
    balanceCents: toCents(-128450), // -$1,284.50 (negative balance)
  },
  {
    id: "acc-cash",
    name: "Cash Wallet",
    type: "cash",
    balanceCents: toCents(0), // $0.00 (zero balance)
  },
]);

export const mockTransactions: readonly Transaction[] = Object.freeze([
  {
    id: "txn-1",
    accountId: "acc-checking",
    date: "2026-08-01", // month boundary
    description: "Rent Payment",
    category: "Housing",
    amountCents: toCents(-215000), // -$2,150.00
  },
  {
    id: "txn-2",
    accountId: "acc-checking",
    date: "2026-08-01", // same-day as txn-1
    description: "Paycheck",
    category: "Income",
    amountCents: toCents(320000), // $3,200.00
  },
  {
    id: "txn-3",
    accountId: "acc-checking",
    date: "2026-07-31", // day before the month boundary
    description: "Grocery Store",
    category: "Groceries",
    amountCents: toCents(-8734), // -$87.34
  },
  {
    id: "txn-4",
    accountId: "acc-credit",
    date: "2026-08-05",
    description: "Refund - Returned Item",
    category: "Shopping",
    amountCents: toCents(4599), // +$45.99 (refund)
  },
  {
    id: "txn-5",
    accountId: "acc-credit",
    date: "2026-08-10",
    description: "Online Subscription",
    category: "Entertainment",
    amountCents: toCents(-1499), // -$14.99
  },
  {
    id: "txn-6",
    accountId: "acc-cash",
    date: "2026-08-12",
    description: "Voided Purchase",
    category: "Dining",
    amountCents: toCents(0), // $0.00 (zero amount)
  },
  {
    id: "txn-7",
    accountId: "acc-savings",
    date: "2026-08-15",
    description: "Interest Payment",
    category: "Income",
    amountCents: toCents(12345), // $123.45
  },
]);
