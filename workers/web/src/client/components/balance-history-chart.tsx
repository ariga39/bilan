import type { BalanceHistorySeries, BalanceProvider } from "@bilan/shared";
import { ChartLine } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatChartDate,
  formatCompactCurrency,
  formatCurrency,
  formatDateTime,
} from "@/lib/format";

const PROVIDER_LABEL: Record<BalanceProvider, string> = {
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

export function BalanceHistoryChart({
  provider,
  series,
}: {
  provider: BalanceProvider;
  series: BalanceHistorySeries;
}) {
  const points = series.points.flatMap((point) =>
    point.total_balance === null
      ? []
      : [{ sampled_at: point.sampled_at, total_balance: point.total_balance }],
  );

  if (points.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">
            {PROVIDER_LABEL[provider]} · {series.currency}
          </CardTitle>
          <CardDescription>No balance points in this window.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ChartLine className="size-4 text-muted-foreground" />
              {PROVIDER_LABEL[provider]}
            </CardTitle>
            <CardDescription>
              Account {series.account} · {points.length} samples
            </CardDescription>
          </div>
          <Badge variant="outline">{series.currency}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="sampled_at"
                tickFormatter={(value) => formatChartDate(String(value))}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                width={72}
                tickFormatter={(value) => formatCompactCurrency(Number(value), series.currency)}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                domain={["auto", "auto"]}
              />
              <Tooltip
                labelFormatter={(label) => formatDateTime(String(label))}
                formatter={(value) => [
                  formatCurrency(Number(value), series.currency),
                  "Remaining balance",
                ]}
                contentStyle={{
                  borderRadius: "var(--radius-md)",
                  borderColor: "var(--border)",
                  fontSize: "12px",
                }}
              />
              <Line
                type="monotone"
                dataKey="total_balance"
                name="Remaining balance"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={points.length === 1 ? { r: 3 } : false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
