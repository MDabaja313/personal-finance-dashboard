"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatCentsCompact } from "@/lib/format/currency";
import type { Cents } from "@/lib/types";

interface NetWorthChartProps {
  data: { label: string; netWorthCents: number }[];
}

const chartConfig: ChartConfig = {
  netWorthCents: { label: "Net Worth", color: "var(--chart-1)" },
};

export function NetWorthChart({ data }: NetWorthChartProps) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
      <AreaChart data={data} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(value: number) => formatCentsCompact(value as Cents)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="netWorthCents"
          type="monotone"
          fill="var(--color-netWorthCents)"
          fillOpacity={0.2}
          stroke="var(--color-netWorthCents)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
