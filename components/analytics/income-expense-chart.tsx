"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCentsCompact } from "@/lib/format/currency";
import type { Cents } from "@/lib/types";

interface IncomeExpenseChartProps {
  data: { label: string; incomeCents: number; spendingCents: number }[];
}

const chartConfig: ChartConfig = {
  incomeCents: { label: "Income", color: "var(--chart-1)" },
  spendingCents: { label: "Spending", color: "var(--chart-2)" },
};

export function IncomeExpenseChart({ data }: IncomeExpenseChartProps) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
      <BarChart data={data} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(value: number) => formatCentsCompact(value as Cents)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="incomeCents" fill="var(--color-incomeCents)" radius={4} />
        <Bar dataKey="spendingCents" fill="var(--color-spendingCents)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
