import { AccountComposition } from "@/components/analytics/account-composition";
import { CashFlowChart } from "@/components/analytics/cash-flow-chart";
import { CategorySpendingBars } from "@/components/analytics/category-spending-bars";
import { ChartDataTable } from "@/components/analytics/chart-data-table";
import { IncomeExpenseChart } from "@/components/analytics/income-expense-chart";
import { NetWorthChart } from "@/components/analytics/net-worth-chart";
import { SavingsRateChart } from "@/components/analytics/savings-rate-chart";
import { PageHeader } from "@/components/shared/page-header";
import { SnapshotStaleNotice } from "@/components/shared/snapshot-stale-notice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccounts } from "@/lib/data/accounts";
import { getCategories } from "@/lib/data/categories";
import { getToday } from "@/lib/data/clock";
import { getNetWorthHistory } from "@/lib/data/net-worth";
import { getTransactions } from "@/lib/data/transactions";
import { accountKind } from "@/lib/finance/accounts";
import { addMonths, monthEnd, monthKey, monthStart } from "@/lib/finance/dates";
import { monthlyTotals, snapshotHealth } from "@/lib/finance/trends";
import { spendingByCategory } from "@/lib/finance/transactions";
import { formatCents } from "@/lib/format/currency";
import { monthLabel } from "@/lib/format/date";
import { formatPercent } from "@/lib/format/percent";
import { toCents } from "@/lib/types";

export default async function AnalyticsPage() {
  const today = await getToday();
  const currentMonth = monthKey(today);
  const months = Array.from({ length: 6 }, (_, i) => addMonths(currentMonth, i - 5));

  const [transactions, accounts, categories, netWorthHistory] = await Promise.all([
    getTransactions({ from: monthStart(months[0]), to: monthEnd(currentMonth) }),
    getAccounts(),
    getCategories(),
    getNetWorthHistory(6),
  ]);

  const totals = monthlyTotals(transactions, months);
  const netWorthByMonth = new Map(netWorthHistory.map((s) => [s.month, s.netWorthCents]));
  const isSnapshotStale = snapshotHealth(accounts, netWorthHistory, currentMonth).status === "stale";

  const trendData = totals.map((t) => ({
    month: t.month,
    label: monthLabel(t.month),
    netWorthCents: toCents(netWorthByMonth.get(t.month) ?? 0),
    incomeCents: t.incomeCents,
    spendingCents: t.spendingCents,
    cashFlowCents: t.cashFlowCents,
    savingsRate: t.savingsRate,
  }));

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const categorySpend = spendingByCategory(transactions, currentMonth)
    .filter((c) => c.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents)
    .map((c) => ({
      categoryId: c.categoryId,
      categoryName: categoryName.get(c.categoryId) ?? c.categoryId,
      amountCents: c.amountCents,
    }));

  const assetAccounts = accounts
    .filter((a) => !a.isArchived && accountKind(a.type) === "asset" && a.balanceCents > 0)
    .sort((a, b) => b.balanceCents - a.balanceCents)
    .map((a) => ({ id: a.id, name: a.name, amountCents: a.balanceCents }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analytics" description="Trends across the last 6 months." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Net Worth Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {isSnapshotStale && <SnapshotStaleNotice />}
            <div aria-hidden="true">
              <NetWorthChart data={trendData} />
            </div>
            <ChartDataTable
              caption="Net worth by month"
              columns={[{ key: "label", label: "Month" }, { key: "value", label: "Net Worth" }]}
              rows={trendData.map((t) => ({ label: t.label, value: formatCents(t.netWorthCents) }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Income vs Expenses</CardTitle>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
              <IncomeExpenseChart data={trendData} />
            </div>
            <ChartDataTable
              caption="Income and spending by month"
              columns={[
                { key: "label", label: "Month" },
                { key: "income", label: "Income" },
                { key: "spending", label: "Spending" },
              ]}
              rows={trendData.map((t) => ({
                label: t.label,
                income: formatCents(t.incomeCents),
                spending: formatCents(t.spendingCents),
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cash Flow</CardTitle>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
              <CashFlowChart data={trendData} />
            </div>
            <ChartDataTable
              caption="Cash flow by month"
              columns={[{ key: "label", label: "Month" }, { key: "value", label: "Cash Flow" }]}
              rows={trendData.map((t) => ({ label: t.label, value: formatCents(t.cashFlowCents) }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Savings Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div aria-hidden="true">
              <SavingsRateChart data={trendData} />
            </div>
            <ChartDataTable
              caption="Savings rate by month"
              columns={[{ key: "label", label: "Month" }, { key: "value", label: "Savings Rate" }]}
              rows={trendData.map((t) => ({ label: t.label, value: formatPercent(t.savingsRate) }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Spending by Category ({monthLabel(currentMonth)})</CardTitle>
          </CardHeader>
          <CardContent>
            {categorySpend.length === 0 ? (
              <p className="text-sm text-muted-foreground">No spending recorded this month.</p>
            ) : (
              <CategorySpendingBars rows={categorySpend} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account Composition</CardTitle>
          </CardHeader>
          <CardContent>
            {assetAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No asset accounts.</p>
            ) : (
              <AccountComposition rows={assetAccounts} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
