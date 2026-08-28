import { AccountSummary } from "@/components/dashboard/account-summary";
import { BudgetStatusSection } from "@/components/dashboard/budget-status";
import { GoalProgressSection } from "@/components/dashboard/goal-progress";
import { KpiRow } from "@/components/dashboard/kpi-row";
import { NetWorthTrend } from "@/components/dashboard/net-worth-trend";
import { RecentTransactions } from "@/components/dashboard/recent-transactions";
import { SpendingByCategory } from "@/components/dashboard/spending-by-category";
import { UpcomingBills } from "@/components/dashboard/upcoming-bills";
import { PageHeader } from "@/components/shared/page-header";
import type { TransactionDisplayRow } from "@/components/transactions/types";
import { getAccounts } from "@/lib/data/accounts";
import { getUpcomingBills } from "@/lib/data/bills";
import { getBudgets } from "@/lib/data/budgets";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getGoals } from "@/lib/data/goals";
import { getNetWorthHistory } from "@/lib/data/net-worth";
import { getRecentTransactions, getTransactions } from "@/lib/data/transactions";
import { netWorth, totalAssets, totalLiabilities } from "@/lib/finance/accounts";
import { billStatus } from "@/lib/finance/bills";
import { budgetStatus } from "@/lib/finance/budgets";
import { addMonths, monthKey } from "@/lib/finance/dates";
import { goalProgress } from "@/lib/finance/goals";
import {
  monthlyCashFlow,
  monthlyIncome,
  monthlySpending,
  savingsRate,
  spendingByCategory,
} from "@/lib/finance/transactions";
import { monthLabel } from "@/lib/format/date";

export default async function DashboardPage() {
  const today = await getToday();
  const currentMonth = monthKey(today);

  const [accounts, allTransactions, recentTransactionsRaw, categories, budgets, upcomingBills, goals, netWorthHistory] =
    await Promise.all([
      getAccounts(),
      getTransactions({ month: currentMonth }),
      getRecentTransactions(5),
      getCategories(),
      getBudgets(currentMonth),
      getUpcomingBills(3),
      getGoals(),
      getNetWorthHistory(6),
    ]);

  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const recentRows: TransactionDisplayRow[] = recentTransactionsRaw.map((t) => ({
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    categoryName: t.categoryId ? (categoryName.get(t.categoryId) ?? t.categoryId) : null,
    accountName: accountName.get(t.accountId) ?? t.accountId,
    kind: t.kind,
    amountCents: t.amountCents,
  }));

  const categorySpend = spendingByCategory(allTransactions, currentMonth)
    .filter((c) => c.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents)
    .map((c) => ({
      categoryId: c.categoryId,
      categoryName: categoryName.get(c.categoryId) ?? c.categoryId,
      amountCents: c.amountCents,
    }));

  // Most-utilized budgets first — that's what a user opening the dashboard
  // needs to see. `getBudgets()` only guarantees a deterministic technical
  // order (category_id ASC), so ties in utilization are broken here by
  // category name — a UUID must never become the tie-break a user sees.
  const budgetStatuses = budgets
    .map((b) => ({ status: budgetStatus(b, allTransactions), categoryName: categoryName.get(b.categoryId) ?? b.categoryId }))
    .sort((a, b) => {
      const utilizationDiff = (b.status.utilization ?? -Infinity) - (a.status.utilization ?? -Infinity);
      return utilizationDiff !== 0 ? utilizationDiff : a.categoryName.localeCompare(b.categoryName);
    })
    .slice(0, 4);

  // getUpcomingBills already returns due_date ASC (name/id tie-broken), so
  // no further sort is needed here.
  const upcomingBillStatuses = upcomingBills.map((b) => billStatus(b, today));

  // getGoals already returns the display order (soonest target date first).
  const goalProgresses = goals.slice(0, 3).map((g) => goalProgress(g, today));

  const months = Array.from({ length: 6 }, (_, i) => addMonths(currentMonth, i - 5));
  const netWorthByMonth = new Map(netWorthHistory.map((s) => [s.month, s.netWorthCents]));
  const trendData = months.map((m) => ({ label: monthLabel(m), netWorthCents: netWorthByMonth.get(m) ?? 0 }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description="Overview of your accounts and recent activity." />

      <KpiRow
        netWorthCents={netWorth(accounts)}
        totalAssetsCents={totalAssets(accounts)}
        totalLiabilitiesCents={totalLiabilities(accounts)}
        monthlyIncomeCents={monthlyIncome(allTransactions, currentMonth)}
        monthlySpendingCents={monthlySpending(allTransactions, currentMonth)}
        cashFlowCents={monthlyCashFlow(allTransactions, currentMonth)}
        savingsRate={savingsRate(allTransactions, currentMonth)}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NetWorthTrend data={trendData} />
        <SpendingByCategory rows={categorySpend} />
        <AccountSummary accounts={accounts.filter((a) => !a.isArchived)} />
        <RecentTransactions rows={recentRows} />
        <UpcomingBills statuses={upcomingBillStatuses} />
        <BudgetStatusSection statuses={budgetStatuses} />
        <GoalProgressSection progresses={goalProgresses} />
      </div>
    </div>
  );
}
