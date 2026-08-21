import Link from "next/link";
import { CategorySpendingBars } from "@/components/analytics/category-spending-bars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Cents } from "@/lib/types";

interface SpendingByCategoryProps {
  rows: { categoryId: string; categoryName: string; amountCents: Cents }[];
}

export function SpendingByCategory({ rows }: SpendingByCategoryProps) {
  const top5 = rows.slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Spending by Category</CardTitle>
        <Link href="/analytics" className="text-xs font-medium text-primary hover:underline">
          View all →
        </Link>
      </CardHeader>
      <CardContent>
        {top5.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spending recorded this month.</p>
        ) : (
          <CategorySpendingBars rows={top5} />
        )}
      </CardContent>
    </Card>
  );
}
