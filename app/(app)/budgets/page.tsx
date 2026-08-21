import { PiggyBank } from "lucide-react";
import { BudgetCard } from "@/components/budgets/budget-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getTransactions } from "@/lib/data/transactions";
import { budgetStatus } from "@/lib/finance/budgets";
import { monthKey } from "@/lib/finance/dates";
import { monthLabel } from "@/lib/format/date";

export default async function BudgetsPage() {
  const today = await getToday();
  const period = monthKey(today);

  const [budgets, transactions, categories] = await Promise.all([
    getBudgets(period),
    getTransactions({ month: period }),
    getCategories(),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Budgets" description={`Category budgets for ${monthLabel(period)}.`} />

      {budgets.length === 0 ? (
        <EmptyState title="No budgets set for this month" icon={PiggyBank} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {budgets.map((budget) => (
            <BudgetCard
              key={budget.id}
              status={budgetStatus(budget, transactions)}
              categoryName={categoryName.get(budget.categoryId) ?? budget.categoryId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
