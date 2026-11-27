import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCompactNumber, formatNumber } from "@/lib/format";
import { buildDailyTrendPoints, sourceLabel } from "@/lib/usage";
import type { DailyUsageGroup, NumberMode } from "@/lib/usage-summary";
import { formatMetric, meteredCaption } from "@/lib/usage-summary";

import { DailyDetailTable, TokenCell } from "./usage-tables";

export function DailyTrendCard({
  group,
  month,
  mode,
}: {
  group: DailyUsageGroup;
  month: string;
  mode: NumberMode;
}) {
  const points = buildDailyTrendPoints(group.rows, month);
  const metered = meteredCaption(group.requests, group.gaps, [
    group.input,
    group.cached,
    group.output,
    group.reasoning,
  ]);
  return (
    <div className="min-w-0 rounded-xl border border-starlight-gold/20 bg-starlight-void/75 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium">{sourceLabel(group.source)}</p>
          {metered ? (
            <span className="text-[11px] text-muted-foreground" title={metered.title}>
              {metered.text}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span title={formatNumber(group.requests)}>
            <strong className="text-foreground tabular-nums">
              {formatMetric(group.requests, mode)}
            </strong>{" "}
            req
          </span>
          <span>
            In{" "}
            <strong className="font-medium text-foreground">
              <TokenCell aggregate={group.input} mode={mode} />
            </strong>
          </span>
          <span>
            Out{" "}
            <strong className="font-medium text-foreground">
              <TokenCell aggregate={group.output} mode={mode} />
            </strong>
          </span>
        </div>
      </div>
      <div
        className="mt-3 h-44 w-full"
        role="img"
        aria-label={`Daily requests trend for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`bar-grad-${group.source}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={
                    group.source === "opencode" ? "var(--starlight-star)" : "var(--starlight-blush)"
                  }
                />
                <stop
                  offset="55%"
                  stopColor={
                    group.source === "opencode"
                      ? "var(--starlight-chart-amber-mid)"
                      : "var(--starlight-chart-rose-mid)"
                  }
                />
                <stop
                  offset="100%"
                  stopColor={
                    group.source === "opencode"
                      ? "var(--starlight-chart-amber-end)"
                      : "var(--starlight-chart-rose-end)"
                  }
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              width={40}
              allowDecimals={false}
              tickFormatter={(value) => formatCompactNumber(Number(value))}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <Tooltip
              cursor={{ fill: "rgba(244, 114, 182, 0.12)" }}
              labelFormatter={(value) => `${month}-${String(Number(value)).padStart(2, "0")}`}
              formatter={(value) => [formatNumber(Number(value)), "Requests"]}
              contentStyle={{
                backgroundColor: "var(--starlight-tooltip)",
                borderRadius: "var(--radius-md)",
                borderColor: "rgba(245, 208, 138, 0.35)",
                color: "var(--starlight-mist)",
                fontSize: "12px",
              }}
            />
            <Bar
              dataKey="requests"
              name="Requests"
              fill={`url(#bar-grad-${group.source})`}
              radius={[8, 8, 2, 2]}
              maxBarSize={20}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 rounded-lg border border-starlight-gold/18 bg-starlight-abyss/80 px-2.5 py-1.5 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">
          Daily values ({group.rows.length})
        </summary>
        <div className="mt-2">
          <DailyDetailTable group={group} mode={mode} />
        </div>
      </details>
    </div>
  );
}
