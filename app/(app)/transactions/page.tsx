import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionList } from "@/components/transactions/transaction-list";
import { TransactionTable } from "@/components/transactions/transaction-table";
import type { TransactionRow } from "@/components/transactions/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getAccounts } from "@/lib/data/accounts";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import {
  MAX_TRANSACTION_LIMIT,
  iterateFetchWindows,
  resolveRevealPage,
} from "@/lib/data/filters";
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

/** Rows revealed per "Load more" press. */
const PAGE_SIZE = 25;

type SearchParamValue = string | string[] | undefined;

function first(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The first `need` transactions for `filters`, read as consecutive bounded
 * queries — never one unbounded fetch, and never a fetch larger than
 * `MAX_TRANSACTION_LIMIT`.
 *
 * Sequential rather than parallel, so it can stop the moment a window comes
 * back short: a short window means the filtered result set is exhausted, and
 * every later window could only be empty. That is what keeps a deep `page` on
 * a small history down to a single query.
 */
async function fetchPrefix(
  filters: Parameters<typeof getTransactions>[0],
  need: number
): Promise<Awaited<ReturnType<typeof getTransactions>>> {
  const rows: Awaited<ReturnType<typeof getTransactions>> = [];

  for (const window of iterateFetchWindows(need, MAX_TRANSACTION_LIMIT)) {
    const batch = await getTransactions({ ...filters, offset: window.offset, limit: window.limit });
    rows.push(...batch);
    if (batch.length < window.limit) break;
  }

  return rows;
}

interface TransactionsPageProps {
  searchParams: Promise<{
    month?: SearchParamValue;
    account?: SearchParamValue;
    category?: SearchParamValue;
    kind?: SearchParamValue;
    search?: SearchParamValue;
    page?: SearchParamValue;
  }>;
}

/**
 * ## Pagination model: cumulative reveal, not replacement
 *
 * `page=N` means "reveal the first `PAGE_SIZE * N` rows", so page 2 renders a
 * strict superset of page 1 — the control genuinely means *load more* rather
 * than *next page*. That is why the DAL call is
 * `offset: 0, limit: revealed`, and deliberately **not**
 * `offset: PAGE_SIZE * (page - 1)`, which would be replacement semantics under
 * a "Load more" label.
 *
 * The cost of re-fetching the already-revealed prefix each time buys the
 * property that matters here: the whole list is one contiguous read of one
 * ordering, so no row can be duplicated or skipped between reveal levels.
 *
 * The prefix is read through `fetchPrefix`, which splits it into consecutive
 * `MAX_TRANSACTION_LIMIT`-sized queries. Every individual query the DAL sees
 * is bounded, and yet arbitrarily old history stays reachable — the per-query
 * ceiling is not a ceiling on how far back the user can go. There is **no**
 * maximum page and no maximum reveal: `resolveRevealPage` accepts any page
 * whose arithmetic stays inside the safe-integer range, and falls back to page
 * 1 only for input that is malformed or would overflow.
 *
 * It is server- and URL-driven end to end: a plain `<Link>` to the same route
 * with `page` incremented. No client fetching layer, no API route, no global
 * state — and the URL stays shareable and bookmarkable, including the reveal
 * depth.
 *
 * Whether another page exists is answered by asking for one row past the
 * window and rendering only the window. No `count` query: a bounded probe row
 * is enough to decide, and an exact total is not information this control
 * needs.
 */
export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const params = await searchParams;
  const kindParam = first(params.kind);
  const kind = VALID_KINDS.includes(kindParam as TransactionKind)
    ? (kindParam as TransactionKind)
    : undefined;

  // No page ceiling: `page` is honored for every value whose reveal
  // arithmetic stays inside the safe-integer range. See `resolveRevealPage`.
  const { page, revealed, need } = resolveRevealPage(first(params.page), PAGE_SIZE);

  const activeFilters = {
    month: first(params.month),
    accountId: first(params.account),
    categoryId: first(params.category),
    kind,
    search: first(params.search),
  };

  const [fetched, accounts, categories, today] = await Promise.all([
    // `need` is `revealed + 1` — the extra row is the has-more probe.
    fetchPrefix(activeFilters, need),
    getAccounts(),
    getCategories(),
    getToday(),
  ]);

  // The probe row is never rendered — it only answers "is there more?".
  const hasMore = fetched.length > revealed;
  const transactions = hasMore ? fetched.slice(0, revealed) : fetched;

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

  // Next URL carries every active filter forward unchanged and increments only
  // `page`, so revealing more never silently widens or drops a filter.
  const nextParams = new URLSearchParams();
  for (const [key, value] of [
    ["month", first(params.month)],
    ["account", first(params.account)],
    ["category", first(params.category)],
    ["kind", kind],
    ["search", first(params.search)],
  ] as const) {
    if (value) nextParams.set(key, value);
  }
  nextParams.set("page", String(page + 1));

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

          {/* Shown iff the probe row exists — there is no page ceiling that
              could hide it while more history remains. */}
          {hasMore && (
            <div className="flex justify-center">
              <Link
                href={`/transactions?${nextParams.toString()}`}
                scroll={false}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Load more
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
