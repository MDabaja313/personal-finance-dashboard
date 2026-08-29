import { PiggyBank } from "lucide-react";
import { AddBudget } from "@/components/budgets/add-budget";
import { BudgetCard } from "@/components/budgets/budget-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getTransactions } from "@/lib/data/transactions";
import { budgetStatus } from "@/lib/finance/budgets";
import { monthKey } from "@/lib/finance/dates";
import { monthLabel } from "@/lib/format/date";

/**
 * Phase 7 CP6: `/budgets` becomes the current-month budget management
 * surface. The Server Actions are imported here, in `app/**`, and handed to
 * the client components as props — `components/**` may not value-import
 * `lib/actions/**`, and may not reach `lib/data/mutations/**` at all.
 */
export default async function BudgetsPage() {
  const today = await getToday();
  const period = monthKey(today);

  const [budgets, transactions, categories] = await Promise.all([
    getBudgets(period),
    getTransactions({ month: period }),
    getCategories(),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  // getBudgets() only guarantees a deterministic technical order
  // (category_id ASC) — the visible list is ordered by category name here,
  // so a UUID never becomes the order a user sees.
  const sortedBudgets = [...budgets].sort((a, b) => {
    const nameA = categoryName.get(a.categoryId) ?? a.categoryId;
    const nameB = categoryName.get(b.categoryId) ?? b.categoryId;
    return nameA.localeCompare(nameB);
  });

  // Every active expense category this month does not already have a
  // budget for — the create form's own category selector, computed here so
  // it can never offer a choice the database would refuse with a unique
  // conflict.
  const budgetedCategoryIds = new Set(budgets.map((b) => b.categoryId));
  const eligibleCategories = categories
    .filter((c) => c.kind === "expense" && !c.isArchived && !budgetedCategoryIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const actions = { update: updateBudgetAction, remove: deleteBudgetAction };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Budgets" description={`Category budgets for ${monthLabel(period)}.`} />

      <AddBudget action={createBudgetAction} eligibleCategories={eligibleCategories} />

      {budgets.length === 0 ? (
        <EmptyState title="No budgets set for this month" icon={PiggyBank} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedBudgets.map((budget) => (
            <BudgetCard
              key={budget.id}
              status={budgetStatus(budget, transactions)}
              categoryName={categoryName.get(budget.categoryId) ?? budget.categoryId}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
