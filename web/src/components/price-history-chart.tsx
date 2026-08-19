"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis, Scatter, ComposedChart } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import type { Sale } from "@/lib/api";

const RANGES = [
  { key: "6M", days: 182 },
  { key: "1Y", days: 365 },
  { key: "2Y", days: 730 },
  { key: "5Y", days: 1825 },
  { key: "10Y", days: 3650 },
  { key: "ALL", days: Infinity },
];

const chartConfig = {
  price: { label: "Sale price", color: "var(--foreground)" },
} satisfies ChartConfig;

export function PriceHistoryChart({ sales }: { sales: Sale[] }) {
  const [range, setRange] = useState("ALL");

  const points = useMemo(() => {
    const cutoffDays = RANGES.find((r) => r.key === range)?.days ?? Infinity;
    const now = Date.now();
    return sales
      // Plot transactions only. A reserve-not-met high bid is not a price the market paid, so
      // charting it would draw a trend line through sales that never happened.
      .filter((s) => s.price != null && s.status !== "reserve_not_met")
      .map((s) => ({ t: new Date(s.date).getTime(), price: s.price as number, date: s.date, mileage: s.mileage }))
      .filter((p) => (now - p.t) / 86400000 <= cutoffDays)
      .sort((a, b) => a.t - b.t);
  }, [sales, range]);

  if (points.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[280px] text-sm text-muted-foreground gap-1">
        <p>No sold prices in this range.</p>
        <p className="text-xs">Try a wider range above.</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3">
      <div className="flex max-w-full justify-start gap-1 overflow-x-auto pb-1 sm:justify-end">
        {RANGES.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={range === r.key ? "default" : "ghost"}
            className="h-7 shrink-0 px-2.5 text-xs"
            onClick={() => setRange(r.key)}
          >
            {r.key}
          </Button>
        ))}
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full min-w-0">
        <ComposedChart data={points} margin={{ left: 4, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v) => new Date(v).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={56}
            tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="price"
                labelFormatter={(_, payload) => {
                  const p = payload?.[0]?.payload;
                  if (!p) return "";
                  const d = new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  return p.mileage ? `${d} · ${p.mileage.toLocaleString()} mi` : d;
                }}
                formatter={(value) => [`$${Number(value).toLocaleString()}`, " sold"]}
              />
            }
          />
          <Line dataKey="price" type="monotone" stroke="var(--color-price)" strokeWidth={1.5} dot={false} />
          <Scatter dataKey="price" fill="var(--color-price)" r={3} />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}
