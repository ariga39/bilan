import type {
  UsageRangePoint,
  UsageRangeResponse,
  UsageRangeSeries,
  UsageRangeWindow,
} from "@bilan/shared";
import { Activity, Clock3 } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import {
  RANGE_WINDOW_OPTIONS,
  buildRangeTrendPoints,
  formatCacheHitRate,
  rangeBoundaryLabel,
  rangeWindowHoursLabel,
  rangeWindowLabel,
  sourceLabel,
} from "@/lib/usage";
import type { NumberMode, TokenAggregate } from "@/lib/usage-summary";
import { formatMetric, meteredCaption, overallCoverageBasis } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { TokenCell } from "./usage-tables";

const SELECTOR_BUTTON =
  "rounded-full px-2.5 py-0.5 transition-all text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function tokenAggregate(row: UsageRangePoint, column: "input" | "output"): TokenAggregate {
  if (column === "input") {
    return {
      value: row.input_tokens,
      counted: row.input_counted,
      units: row.unit_count,
    };
  }
  return {
    value: row.output_tokens,
    counted: row.output_counted,
    units: row.unit_count,
  };
}

function CacheRate({ series }: { series: UsageRangeSeries }) {
  const { totals } = series;
  if (totals.cache_hit_rate === null) {
    return (
      <span
        aria-label="Cache hit rate unavailable"
        title="Unavailable because the cached-input and input counters are missing, cover different requests, or the input denominator is zero."
        className="text-muted-foreground"
      >
        —
      </span>
    );
  }
  const partial =
    totals.cached_counted < totals.unit_count || totals.input_counted < totals.unit_count;
  return (
    <span
      aria-label={`Cache hit rate ${formatCacheHitRate(totals.cache_hit_rate)}`}
      title={`${formatNumber(totals.cached_tokens ?? 0)} cached input tokens / ${formatNumber(
        totals.input_tokens ?? 0,
      )} input tokens · ${formatNumber(totals.cached_counted)}/${formatNumber(
        totals.unit_count,
      )} requests measured`}
      className="inline-flex items-baseline gap-1 tabular-nums"
    >
      <span>{formatCacheHitRate(totals.cache_hit_rate)}</span>
      {partial ? (
        <span className="text-[10px] font-normal text-muted-foreground">
          {formatNumber(totals.cached_counted)}/{formatNumber(totals.unit_count)} req
        </span>
      ) : null}
    </span>
  );
}

function TrendChart({
  series,
  range,
  metric,
  title,
  color,
  percent = false,
  mode,
}: {
  series: UsageRangeSeries;
  range: UsageRangeResponse;
  metric: "requests" | "input" | "output" | "cacheHitRate";
  title: string;
  color: string;
  percent?: boolean;
  mode: NumberMode;
}) {
  const points = buildRangeTrendPoints(series, range);
  const gradientId = `range-${series.source}-${series.accounting_basis}-${metric}`.replaceAll(
    /[^a-zA-Z0-9-]/gu,
    "-",
  );
  return (
    <div className="min-w-0 rounded-lg border border-starlight-gold/15 bg-starlight-void/55 p-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      <div
        className="mt-1 h-28 w-full"
        role="img"
        aria-label={`${title} trend for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.55} />
                <stop offset="100%" stopColor={color} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              minTickGap={18}
              tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              width={36}
              allowDecimals={percent}
              domain={percent ? [0, 1] : [0, "auto"]}
              tickFormatter={(value) =>
                percent ? formatCacheHitRate(Number(value)) : formatCompactNumber(Number(value))
              }
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
            />
            <Tooltip
              cursor={{ stroke: "rgba(244, 114, 182, 0.35)" }}
              formatter={(value) => {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) {
                  return ["Unavailable", title];
                }
                return [percent ? formatCacheHitRate(numeric) : formatMetric(numeric, mode), title];
              }}
              contentStyle={{
                backgroundColor: "var(--starlight-tooltip)",
                borderRadius: "var(--radius-md)",
                borderColor: "rgba(245, 208, 138, 0.35)",
                color: "var(--starlight-mist)",
                fontSize: "11px",
              }}
            />
            <Area
              type="monotone"
              dataKey={metric}
              name={title}
              stroke={color}
              strokeWidth={1.8}
              fill={`url(#${gradientId})`}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RangeDetailTable({ series, mode }: { series: UsageRangeSeries; mode: NumberMode }) {
  return (
    <details className="rounded-lg border border-starlight-gold/18 bg-starlight-abyss/80 px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        Observed values ({series.points.length} {series.points.length === 1 ? "point" : "points"})
      </summary>
      <div className="mt-2 max-w-full overflow-x-auto rounded-lg border">
        <table
          className="w-full text-sm"
          aria-label={`Rolling detail for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
        >
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Start</th>
              <th className="px-3 py-2 text-right font-medium">Requests</th>
              <th className="px-3 py-2 text-right font-medium">Input</th>
              <th className="px-3 py-2 text-right font-medium">Cached</th>
              <th className="px-3 py-2 text-right font-medium">Output</th>
              <th className="px-3 py-2 text-right font-medium">Cache hit</th>
            </tr>
          </thead>
          <tbody>
            {series.points.map((point) => (
              <tr key={`${series.source}-${point.start}`} className="border-t">
                <td className="px-3 py-1.5 font-mono text-xs">
                  {point.date}
                  {point.includes_current_hour ? " (partial hour)" : ""}
                </td>
                <td
                  className="px-3 py-1.5 text-right tabular-nums"
                  title={formatNumber(point.unit_count)}
                >
                  {formatMetric(point.unit_count, mode)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <TokenCell aggregate={tokenAggregate(point, "input")} mode={mode} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <TokenCell
                    aggregate={{
                      value: point.cached_tokens,
                      counted: point.cached_counted,
                      units: point.unit_count,
                    }}
                    mode={mode}
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <TokenCell aggregate={tokenAggregate(point, "output")} mode={mode} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {point.cache_hit_rate === null ? (
                    <span aria-label="Cache hit rate unavailable" className="text-muted-foreground">
                      —
                    </span>
                  ) : (
                    formatCacheHitRate(point.cache_hit_rate)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function RangeSeriesCard({
  series,
  range,
  mode,
}: {
  series: UsageRangeSeries;
  range: UsageRangeResponse;
  mode: NumberMode;
}) {
  const metered = meteredCaption(
    series.totals.unit_count,
    series.totals.coverage_gaps,
    [
      {
        value: series.totals.input_tokens,
        counted: series.totals.input_counted,
        units: series.totals.unit_count,
      },
      {
        value: series.totals.output_tokens,
        counted: series.totals.output_counted,
        units: series.totals.unit_count,
      },
    ],
    { basis: overallCoverageBasis(series.source) },
  );
  return (
    <div
      role="group"
      aria-label={`Rolling usage for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
      className="min-w-0 rounded-xl border border-starlight-gold/20 bg-starlight-void/75 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-sm font-medium">{sourceLabel(series.source)}</p>
          <span className="text-[11px] text-muted-foreground">
            {series.accounting_basis} · {series.unit_kind}
          </span>
          {metered ? (
            <span className="text-[11px] text-muted-foreground" title={metered.title}>
              {metered.text}
            </span>
          ) : null}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {range.granularity === "hour" ? "Hourly" : "Daily"} detail
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Requests</dt>
          <dd
            className="truncate text-lg font-semibold tabular-nums"
            title={formatNumber(series.totals.unit_count)}
          >
            {formatMetric(series.totals.unit_count, mode)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Input</dt>
          <dd className="truncate text-lg font-semibold">
            <TokenCell
              aggregate={{
                value: series.totals.input_tokens,
                counted: series.totals.input_counted,
                units: series.totals.unit_count,
              }}
              mode={mode}
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Output</dt>
          <dd className="truncate text-lg font-semibold">
            <TokenCell
              aggregate={{
                value: series.totals.output_tokens,
                counted: series.totals.output_counted,
                units: series.totals.unit_count,
              }}
              mode={mode}
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Cache hit rate</dt>
          <dd className="truncate text-lg font-semibold">
            <CacheRate series={series} />
          </dd>
        </div>
      </dl>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <TrendChart
          series={series}
          range={range}
          metric="requests"
          title="Requests"
          color="var(--starlight-star)"
          mode={mode}
        />
        <TrendChart
          series={series}
          range={range}
          metric="input"
          title="Input tokens"
          color="var(--starlight-blush)"
          mode={mode}
        />
        <TrendChart
          series={series}
          range={range}
          metric="output"
          title="Output tokens"
          color="var(--starlight-periwinkle)"
          mode={mode}
        />
        <TrendChart
          series={series}
          range={range}
          metric="cacheHitRate"
          title="Cache hit rate"
          color="var(--starlight-teal)"
          percent
          mode={mode}
        />
      </div>

      <div className="mt-2">
        <RangeDetailTable series={series} mode={mode} />
      </div>
    </div>
  );
}

export function RollingUsageSection({
  range,
  window,
  mode,
  loading = false,
  error = null,
  onWindowChange,
}: {
  range: UsageRangeResponse | null;
  window: UsageRangeWindow;
  mode: NumberMode;
  loading?: boolean;
  error?: string | null;
  onWindowChange: (window: UsageRangeWindow) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2.5 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-base tracking-[0.08em] text-starlight-parchment"
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-teal-300/40 bg-teal-400/15 text-teal-200">
              <Activity className="size-3.5" />
            </span>
            Rolling usage
          </CardTitle>
          <div
            role="group"
            aria-label="Rolling usage window"
            className="inline-flex h-8 items-center rounded-full border border-starlight-gold/30 bg-starlight-night p-0.5 text-xs"
          >
            {RANGE_WINDOW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={window === option.value}
                title={option.label}
                className={cn(
                  SELECTOR_BUTTON,
                  window === option.value
                    ? "bg-gradient-to-r from-starlight-rose to-starlight-violet font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  onWindowChange(option.value);
                }}
              >
                {option.shortLabel}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{range ? rangeWindowLabel(range.window) : rangeWindowLabel(window)}</span>
            <span aria-hidden="true">·</span>
            <span title="The range ends after the UTC hour containing now.">
              Hour-based boundary · includes the current partial hour
            </span>
            {range ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{rangeWindowHoursLabel(range.window)}</span>
              </>
            ) : null}
          </p>
          {range ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3" />
              {rangeBoundaryLabel(range)}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {range === null ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
            {loading
              ? "Loading rolling usage…"
              : (error ?? "Rolling usage is unavailable. Monthly history remains available.")}
          </p>
        ) : range.series.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
            No usage in this rolling {rangeWindowLabel(range.window).toLowerCase()} range.
          </p>
        ) : (
          range.series.map((series) => (
            <RangeSeriesCard
              key={`${series.source}\u0000${series.accounting_basis}\u0000${series.unit_kind}`}
              series={series}
              range={range}
              mode={mode}
            />
          ))
        )}
        {range?.bucket_attribution === "approximate" ? (
          <p
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            {range.bucket_attribution_note}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
