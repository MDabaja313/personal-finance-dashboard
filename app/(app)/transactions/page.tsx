import { ArrowLeftRight } from "lucide-react";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionList } from "@/components/transactions/transaction-list";
import { TransactionTable } from "@/components/transactions/transaction-table";
import type { TransactionRow } from "@/components/transactions/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getAccounts } from "@/lib/data/accounts";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getTransactions } from "@/lib/data/transactions";
import { addMonths, listMonths, monthKey } from "@/lib/finance/dates";
import { monthLabel } from "@/lib/format/date";
import type { TransactionKind } from "@/lib/types";

const VALID_KINDS: readonly TransactionKind[] = [
  "income",
  "expense",
  "refund",
  "transfer",
  "credit_card_payment",
];

type SearchParamValue = string | string[] | undefined;

function first(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface TransactionsPageProps {
  searchParams: Promise<{
    month?: SearchParamValue;
    account?: SearchParamValue;
    category?: SearchParamValue;
    kind?: SearchParamValue;
    search?: SearchParamValue;
  }>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const params = await searchParams;
  const kindParam = first(params.kind);
  const kind = VALID_KINDS.includes(kindParam as TransactionKind)
    ? (kindParam as TransactionKind)
    : undefined;

  const [transactions, accounts, categories, today] = await Promise.all([
    getTransactions({
      month: first(params.month),
      accountId: first(params.account),
      categoryId: first(params.category),
      kind,
      search: first(params.search),
    }),
    getAccounts(),
    getCategories(),
    getToday(),
  ]);

  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const rows: TransactionRow[] = transactions.map((t) => ({
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    categoryName: t.categoryId ? (categoryName.get(t.categoryId) ?? t.categoryId) : null,
    accountName: accountName.get(t.accountId) ?? t.accountId,
    kind: t.kind,
    amountCents: t.amountCents,
  }));

  const currentMonth = monthKey(today);
  const months = listMonths(addMonths(currentMonth, -5), currentMonth)
    .reverse()
    .map((m) => ({ value: m, label: monthLabel(m) }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Transactions" description="Full transaction history across all accounts." />

      <TransactionFilters months={months} accounts={accounts} categories={categories} />

      {rows.length === 0 ? (
        <EmptyState title="No transactions match these filters" icon={ArrowLeftRight} />
      ) : (
        <>
          <TransactionTable rows={rows} />
          <TransactionList rows={rows} />
        </>
      )}
    </div>
  );
}
