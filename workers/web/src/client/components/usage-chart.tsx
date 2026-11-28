import { ChevronDown } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { buildDailyTrendPoints, sourceLabel } from "@/lib/usage";
import type { DailyUsageGroup, NumberMode } from "@/lib/usage-summary";
import { formatMetric, meteredCaption, overallCoverageBasis } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { DailyDetailTable, TokenCell, sourceAccent } from "./usage-tables";

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
  const metered = meteredCaption(
    group.requests,
    group.gaps,
    [group.input, group.cached, group.output, group.reasoning],
    { basis: overallCoverageBasis(group.source) },
  );
  const accent = sourceAccent(group.source);

  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-4">
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-6 top-0 h-[2px] bg-gradient-to-r",
          accent.accentLine,
        )}
      />
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", accent.dot)} />
            <p
              style={{ fontFamily: "var(--font-display)" }}
              className={cn("truncate text-sm font-semibold tracking-wide", accent.title)}
            >
              {sourceLabel(group.source)}
            </p>
            {metered ? (
              <span
                className="rounded-full border border-starlight-gold/18 bg-starlight-void/80 px-2 py-0.5 text-[10px] text-starlight-violet-muted"
                title={metered.title}
              >
                {metered.text}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className="rounded-full border border-starlight-gold/15 bg-starlight-void/80 px-2 py-0.5"
              title={formatNumber(group.requests)}
            >
              <strong className="font-semibold text-starlight-mist tabular-nums">
                {formatMetric(group.requests, mode)}
              </strong>{" "}
              req
            </span>
            <span className="rounded-full border border-starlight-gold/15 bg-starlight-void/80 px-2 py-0.5">
              In{" "}
              <strong className="font-medium text-starlight-parchment">
                <TokenCell aggregate={group.input} mode={mode} />
              </strong>
            </span>
            <span className="rounded-full border border-starlight-gold/15 bg-starlight-void/80 px-2 py-0.5">
              Out{" "}
              <strong className="font-medium text-starlight-blush">
                <TokenCell aggregate={group.output} mode={mode} />
              </strong>
            </span>
          </div>
        </div>

        <div
          className="h-44 w-full rounded-xl border border-starlight-gold/12 bg-starlight-abyss/60 px-2 pt-2 pb-1"
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
                      group.source === "opencode"
                        ? "var(--starlight-star)"
                        : "var(--starlight-blush)"
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
              <CartesianGrid
                vertical={false}
                stroke="rgba(245, 208, 138, 0.12)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                minTickGap={14}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                width={38}
                allowDecimals={false}
                tickFormatter={(value) => formatCompactNumber(Number(value))}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              />
              <Tooltip
                cursor={{ fill: "rgba(244, 114, 182, 0.1)" }}
                labelFormatter={(value) => `${month}-${String(Number(value)).padStart(2, "0")}`}
                formatter={(value) => [formatNumber(Number(value)), "Requests"]}
                contentStyle={{
                  backgroundColor: "var(--starlight-tooltip)",
                  borderRadius: "var(--radius-md)",
                  borderColor: "rgba(245, 208, 138, 0.35)",
                  color: "var(--starlight-mist)",
                  fontSize: "12px",
                  boxShadow: "0 10px 28px -8px rgba(15, 11, 34, 0.85)",
                }}
              />
              <Bar
                dataKey="requests"
                name="Requests"
                fill={`url(#bar-grad-${group.source})`}
                radius={[6, 6, 2, 2]}
                maxBarSize={18}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <details className="group rounded-xl border border-starlight-gold/15 bg-starlight-abyss/65 text-xs">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>Daily values ({group.rows.length})</span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 text-starlight-gold/70 transition-transform duration-200 group-open:rotate-180"
            />
          </summary>
          <div className="border-t border-starlight-gold/12 p-2.5">
            <DailyDetailTable group={group} mode={mode} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
