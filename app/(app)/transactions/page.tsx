import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { AddMovement } from "@/components/movements/add-movement";
import type {
  MovementAccountOption,
  MovementEditRow,
} from "@/components/movements/types";
import { AddTransaction } from "@/components/transactions/add-transaction";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionList } from "@/components/transactions/transaction-list";
import { TransactionTable } from "@/components/transactions/transaction-table";
import type {
  AccountOption,
  CategoryOption,
  TransactionRow,
} from "@/components/transactions/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import {
  createMovementAction,
  deleteMovementAction,
  updateMovementAction,
} from "@/lib/actions/movements";
import {
  createTransactionAction,
  deleteTransactionAction,
  updateTransactionAction,
} from "@/lib/actions/transactions";
import { getAccounts } from "@/lib/data/accounts";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import {
  MAX_TRANSACTION_LIMIT,
  iterateFetchWindows,
  resolveRevealPage,
} from "@/lib/data/filters";
import { getMovements } from "@/lib/data/movements";
import { getTransactions } from "@/lib/data/transactions";
import { addMonths, listMonths, monthKey } from "@/lib/finance/dates";
import { monthLabel } from "@/lib/format/date";
import type { TransactionKind } from "@/lib/types";
import { TRANSACTION_KINDS, isOrdinaryTransactionKind } from "@/lib/types/enums";

/**
 * Every kind a stored row can carry — the filter accepts all of them,
 * `adjustment` included, because filtering and creating are different
 * questions. Read from the single canonical list rather than re-spelled, so a
 * kind added to the enum is filterable without a second edit here.
 */
const VALID_KINDS: readonly TransactionKind[] = TRANSACTION_KINDS;

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

  /**
   * The movements behind whatever legs this page happens to be rendering.
   *
   * Read by movement id, in one batched query, rather than by pairing two
   * rendered rows — and that distinction is the whole reason this exists.
   * `/transactions` renders a bounded reveal window, so a movement's two legs
   * routinely straddle its edge: reconstructing "from account", "to account"
   * and "amount" from the rows on screen would work by accident, and would
   * offer no edit control at all on exactly the pairs that are hardest to find
   * by hand.
   *
   * A second roundtrip after the ledger read, because it depends on which rows
   * came back. It is skipped entirely when the window contains no legs, and it
   * costs two bounded queries when it does — not two per row.
   */
  const movements = await getMovements(
    transactions.filter((t) => t.movementId !== undefined).map((t) => t.movementId!)
  );
  const movementById = new Map(movements.map((m) => [m.id, m]));

  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const rows: TransactionRow[] = transactions.map((t) => {
    /**
     * Attached to the source (negative) leg and to nothing else.
     *
     * A movement is two rows in the ledger and one editable thing, so exactly
     * one of its rows carries the controls. Which one is decided here, on the
     * server, from `getMovements()`'s own source/destination resolution — never
     * inferred in a component — so the rule has one definition and a pair can
     * never grow two sets of buttons.
     */
    const movement =
      t.movementId !== undefined && movementById.get(t.movementId)?.sourceLegId === t.id
        ? movementById.get(t.movementId)
        : undefined;

    return {
      id: t.id,
      date: t.date,
      merchant: t.merchant,
      accountId: t.accountId,
      accountName: accountName.get(t.accountId) ?? t.accountId,
      categoryId: t.categoryId ?? null,
      categoryName: t.categoryId ? (categoryName.get(t.categoryId) ?? t.categoryId) : null,
      kind: t.kind,
      amountCents: t.amountCents,
      // Ordinary rows only. A movement leg is never editable *as a row* — one
      // leg cannot be edited or deleted without leaving the movement invalid —
      // and an adjustment is a CP5 reconciliation outcome the database refuses
      // to let an UPDATE target. Both stay fully visible here.
      editable: isOrdinaryTransactionKind(t.kind),
      ...(movement
        ? {
            movement: {
              id: movement.id,
              kind: movement.kind,
              date: movement.date,
              fromAccountId: movement.fromAccountId,
              toAccountId: movement.toAccountId,
              sourceLegId: movement.sourceLegId,
              destinationLegId: movement.destinationLegId,
              amountCents: movement.amountCents,
              // The label a screen reader hears on "Edit"/"Delete" — the leg's
              // own rendered merchant, which the database composed from the
              // movement's kind and the other account's name.
              label: t.merchant,
            } satisfies MovementEditRow,
          }
        : {}),
    };
  });

  /**
   * What the entry form may post to: active accounts and active categories
   * only.
   *
   * Archived rows are still *read* — `getAccounts()`/`getCategories()` return
   * them, and they are what resolves the names on historical rows above — but
   * offering one in a picker would be offering a control that always fails:
   * `assert_transaction_refs()` refuses an archived account or category, and
   * the mutation layer refuses it first with "unarchive it before using it".
   */
  const accountOptions: AccountOption[] = accounts
    .filter((a) => !a.isArchived)
    .map((a) => ({ id: a.id, name: a.name }));

  const categoryOptions: CategoryOption[] = categories
    .filter((c) => !c.isArchived)
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind }));

  /**
   * The same active accounts, plus each one's `type`.
   *
   * A movement form needs the type and an ordinary transaction form does not:
   * a credit-card payment must be paid *into* a `credit` account, so the
   * destination picker narrows itself to those. Kept as its own option shape
   * rather than widening `AccountOption`, so the extra field travels only to
   * the surface that has a use for it.
   */
  const movementAccountOptions: MovementAccountOption[] = accounts
    .filter((a) => !a.isArchived)
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));

  // Imported here, in app/**, and handed to the client components as props:
  // components/** may not value-import lib/actions/**, and may not reach
  // lib/data/mutations/** at all. The route is the seam.
  const mutationActions = {
    create: createTransactionAction,
    update: updateTransactionAction,
    remove: deleteTransactionAction,
  };

  const movementActions = {
    create: createMovementAction,
    update: updateMovementAction,
    remove: deleteMovementAction,
  };

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

      {/* Two entry points, deliberately. An ordinary transaction is one row in
          one account with a merchant and a category; a movement is a pair of
          rows across two accounts with neither. The ordinary form still offers
          income/expense/refund only. */}
      <div className="flex flex-wrap items-center gap-2">
        <AddTransaction
          action={createTransactionAction}
          accounts={accountOptions}
          categories={categoryOptions}
          today={today}
        />
        <AddMovement
          action={createMovementAction}
          accounts={movementAccountOptions}
          today={today}
        />
      </div>

      <TransactionFilters months={months} accounts={accounts} categories={categories} />

      {rows.length === 0 ? (
        <EmptyState title="No transactions match these filters" icon={ArrowLeftRight} />
      ) : (
        <>
          <TransactionTable
            rows={rows}
            actions={mutationActions}
            movementActions={movementActions}
            accounts={accountOptions}
            movementAccounts={movementAccountOptions}
            categories={categoryOptions}
            today={today}
          />
          <TransactionList
            rows={rows}
            actions={mutationActions}
            movementActions={movementActions}
            accounts={accountOptions}
            movementAccounts={movementAccountOptions}
            categories={categoryOptions}
            today={today}
          />

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
