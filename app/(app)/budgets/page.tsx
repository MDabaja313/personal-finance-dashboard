import { PiggyBank } from "lucide-react";
import { AddBudget } from "@/components/budgets/add-budget";
import { BudgetCard } from "@/components/budgets/budget-card";
import { MonthlyPlanSummary } from "@/components/budgets/monthly-plan-summary";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from "@/lib/actions/budgets";
import { clearMonthlyPlanAction, setMonthlyPlanAction } from "@/lib/actions/monthly-plans";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getMonthlyPlan } from "@/lib/data/monthly-plans";
import { getTransactions } from "@/lib/data/transactions";
import { budgetStatus } from "@/lib/finance/budgets";
import { monthKey } from "@/lib/finance/dates";
import { monthlyPlanSummary } from "@/lib/finance/planning";
import { monthLabel } from "@/lib/format/date";

/**
 * Phase 7 CP6: `/budgets` becomes the current-month budget management
 * surface. Phase 8 CP2 puts a Monthly Plan summary above it, so the page
 * starts from income rather than from a list of spending limits.
 *
 * The Server Actions are imported here, in `app/**`, and handed to the client
 * components as props — `components/**` may not value-import `lib/actions/**`,
 * and may not reach `lib/data/mutations/**` at all.
 *
 * ## The plan and the budgets are separate rows, deliberately
 *
 * `getMonthlyPlan()` reads one `monthly_plans` row; `getBudgets()` reads the
 * category limits. Expected income is not a budget and is not stored as one:
 * it has no category, `assert_budget_category_active_expense()` would refuse it
 * if it did, and `budgetStatus()` would render it as a permanently-unused
 * spending meter. See `supabase/migrations/20260902120002_monthly_plans.sql`.
 *
 * Every actual figure in the summary comes from the same `transactions` read
 * the budget cards use, through `lib/finance/planning.ts` — which calls
 * `monthlyIncome`/`monthlySpending`/`monthlyCashFlow` rather than
 * reimplementing them, so a plan can never disagree with the dashboard about
 * what a month earned.
 */
export default async function BudgetsPage() {
  const today = await getToday();
  const period = monthKey(today);

  const [budgets, transactions, categories, plan] = await Promise.all([
    getBudgets(period),
    getTransactions({ month: period }),
    getCategories(),
    getMonthlyPlan(period),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const planSummary = monthlyPlanSummary(plan, budgets, transactions, period);

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
      <PageHeader
        title="Budgets"
        description={`Monthly plan and category budgets for ${monthLabel(period)}.`}
      />

      <MonthlyPlanSummary
        summary={planSummary}
        monthLabel={monthLabel(period)}
        actions={{ set: setMonthlyPlanAction, clear: clearMonthlyPlanAction }}
      />

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
