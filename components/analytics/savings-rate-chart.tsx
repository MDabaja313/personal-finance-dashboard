"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

interface SavingsRateChartProps {
  data: { label: string; savingsRate: number | null }[];
}

const chartConfig: ChartConfig = {
  savingsRate: { label: "Savings Rate", color: "var(--chart-1)" },
};

export function SavingsRateChart({ data }: SavingsRateChartProps) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
      <LineChart data={data} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => `${value}%`} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          dataKey="savingsRate"
          type="monotone"
          stroke="var(--color-savingsRate)"
          strokeWidth={2}
          dot
          connectNulls={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
