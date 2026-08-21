"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatCentsCompact } from "@/lib/format/currency";
import type { Cents } from "@/lib/types";

interface CashFlowChartProps {
  data: { month: string; label: string; cashFlowCents: number }[];
}

const chartConfig: ChartConfig = {
  cashFlowCents: { label: "Cash Flow", color: "var(--chart-1)" },
};

/** Diverging bar — polarity (above/below zero) is the point, so per-bar color by sign is intentional here. */
export function CashFlowChart({ data }: CashFlowChartProps) {
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
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="cashFlowCents" radius={4}>
          {data.map((row) => (
            <Cell
              key={row.month}
              fill={row.cashFlowCents < 0 ? "var(--destructive)" : "var(--color-cashFlowCents)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
