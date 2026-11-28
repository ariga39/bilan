import type {
  UsageRangePoint,
  UsageRangeResponse,
  UsageRangeSeries,
  UsageRangeWindow,
} from "@bilan/shared";
import { Activity, ChevronDown, Clock3 } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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
  rangeWindowLabel,
  sourceLabel,
} from "@/lib/usage";
import type { NumberMode, TokenAggregate } from "@/lib/usage-summary";
import { formatMetric, meteredCaption, overallCoverageBasis } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { TokenCell, sourceAccent } from "./usage-tables";

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
        className="text-muted-foreground/70"
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
      className="inline-flex max-w-full flex-wrap items-baseline gap-x-1 tabular-nums"
    >
      <span>{formatCacheHitRate(totals.cache_hit_rate)}</span>
      {partial ? (
        <span className="text-[10px] font-normal text-starlight-gold/80">
          {formatNumber(totals.cached_counted)}/{formatNumber(totals.unit_count)} req
        </span>
      ) : null}
    </span>
  );
}

/**
 * Volume metrics (requests, input, output) render as discrete bars; cache hit
 * rate is a continuous 0–100% ratio so it renders as a smooth area line.
 */
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
  const tooltipStyle = {
    backgroundColor: "var(--starlight-tooltip)",
    borderRadius: "var(--radius-md)",
    borderColor: "rgba(245, 208, 138, 0.35)",
    color: "var(--starlight-mist)",
    fontSize: "11px",
    boxShadow: "0 10px 28px -8px rgba(15, 11, 34, 0.85)",
  };

  return (
    <div className="min-w-0 rounded-xl border border-starlight-gold/12 bg-starlight-abyss/70 p-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </p>
      <div
        className="mt-1.5 h-24 w-full"
        role="img"
        aria-label={`${title} trend for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          {percent ? (
            <AreaChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.48} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke="rgba(245, 208, 138, 0.1)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={22}
                tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                width={34}
                allowDecimals
                domain={[0, 1]}
                tickFormatter={(value) => formatCacheHitRate(Number(value))}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              />
              <Tooltip
                cursor={{ stroke: "rgba(94, 234, 212, 0.4)" }}
                formatter={(value) => {
                  const numeric = Number(value);
                  if (!Number.isFinite(numeric)) {
                    return ["Unavailable", title];
                  }
                  return [formatCacheHitRate(numeric), title];
                }}
                contentStyle={tooltipStyle}
              />
              <Area
                type="monotone"
                dataKey={metric}
                name={title}
                stroke={color}
                strokeWidth={1.8}
                fill={`url(#${gradientId})`}
                connectNulls={false}
                dot={{ r: 1.8, fill: color, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </AreaChart>
          ) : (
            <BarChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.42} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke="rgba(245, 208, 138, 0.1)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={22}
                tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                width={34}
                allowDecimals={false}
                domain={[0, "auto"]}
                tickFormatter={(value) => formatCompactNumber(Number(value))}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              />
              <Tooltip
                cursor={{ fill: "rgba(244, 114, 182, 0.1)" }}
                formatter={(value) => {
                  const numeric = Number(value);
                  if (!Number.isFinite(numeric)) {
                    return ["Unavailable", title];
                  }
                  return [formatMetric(numeric, mode), title];
                }}
                contentStyle={tooltipStyle}
              />
              <Bar
                dataKey={metric}
                name={title}
                fill={`url(#${gradientId})`}
                radius={[4, 4, 1, 1]}
                maxBarSize={14}
                isAnimationActive={false}
              />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RangeDetailTable({
  series,
  mode,
  range,
}: {
  series: UsageRangeSeries;
  mode: NumberMode;
  range: UsageRangeResponse;
}) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: range.timezone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
  const tableTitle = range.granularity === "hour" ? "Hourly data" : "Daily data";
  return (
    <details className="group rounded-xl border border-starlight-gold/15 bg-starlight-abyss/65 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span>
          {tableTitle} ({series.points.length})
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 text-starlight-gold/70 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-starlight-gold/12 p-2.5">
        <div className="max-w-full overflow-x-auto rounded-xl border border-starlight-gold/15 bg-starlight-abyss/75">
          <table
            className="w-full text-xs sm:text-sm"
            aria-label={`Rolling detail for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
          >
            <thead className="bg-starlight-night/90 text-left text-[11px] uppercase tracking-wider text-starlight-gold/75">
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
                <tr
                  key={`${series.source}-${point.start}`}
                  className="border-t border-starlight-gold/10 transition-colors hover:bg-starlight-violet/10"
                >
                  <td className="px-3 py-2 font-mono text-xs text-starlight-violet-muted">
                    {point.date}
                    {range.granularity === "hour" ? " " + hour.format(new Date(point.start)) : ""}
                    {point.includes_current_hour ? " (partial)" : ""}
                  </td>
                  <td
                    className="px-3 py-2 text-right font-medium text-starlight-mist tabular-nums"
                    title={formatNumber(point.unit_count)}
                  >
                    {formatMetric(point.unit_count, mode)}
                  </td>
                  <td className="px-3 py-2 text-right text-foreground/90">
                    <TokenCell aggregate={tokenAggregate(point, "input")} mode={mode} />
                  </td>
                  <td className="px-3 py-2 text-right text-foreground/90">
                    <TokenCell
                      aggregate={{
                        value: point.cached_tokens,
                        counted: point.cached_counted,
                        units: point.unit_count,
                      }}
                      mode={mode}
                    />
                  </td>
                  <td className="px-3 py-2 text-right text-foreground/90">
                    <TokenCell aggregate={tokenAggregate(point, "output")} mode={mode} />
                  </td>
                  <td className="px-3 py-2 text-right text-starlight-teal-soft tabular-nums">
                    {point.cache_hit_rate === null ? (
                      <span
                        aria-label="Cache hit rate unavailable"
                        className="text-muted-foreground/70"
                      >
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
      </div>
    </details>
  );
}

function RangeSeriesPanel({
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
  const accent = sourceAccent(series.source);

  return (
    <div
      role="group"
      aria-label={`Rolling usage for ${sourceLabel(series.source)} · ${series.accounting_basis} · ${series.unit_kind}`}
      className="relative min-w-0 space-y-3 overflow-hidden rounded-xl border border-starlight-gold/18 bg-starlight-void/80 p-3.5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-4 top-0 h-[2px] bg-gradient-to-r",
          accent.accentLine,
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex items-center gap-2"
          title={`${series.accounting_basis} · ${series.unit_kind}`}
        >
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", accent.dot)} />
          <h3
            style={{ fontFamily: "var(--font-display)" }}
            className={cn("text-sm font-semibold tracking-wide", accent.title)}
          >
            {sourceLabel(series.source)}
          </h3>
        </div>
        {metered ? (
          <span
            className="rounded-full border border-starlight-gold/18 bg-starlight-abyss/80 px-2 py-0.5 text-[10px] text-starlight-violet-muted"
            title={metered.title}
          >
            {metered.text}
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="min-w-0 rounded-xl border border-starlight-gold/12 bg-starlight-abyss/70 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Requests
          </dt>
          <dd
            className="mt-0.5 wrap-anywhere text-lg font-bold tracking-tight text-starlight-mist tabular-nums sm:text-xl"
            title={formatNumber(series.totals.unit_count)}
          >
            {formatMetric(series.totals.unit_count, mode)}
          </dd>
        </div>
        <div className="min-w-0 rounded-xl border border-starlight-gold/12 bg-starlight-abyss/70 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Input
          </dt>
          <dd className="mt-0.5 wrap-anywhere text-lg font-semibold text-starlight-parchment sm:text-xl">
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
        <div className="min-w-0 rounded-xl border border-starlight-gold/12 bg-starlight-abyss/70 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Output
          </dt>
          <dd className="mt-0.5 wrap-anywhere text-lg font-semibold text-starlight-blush sm:text-xl">
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
        <div className="min-w-0 rounded-xl border border-starlight-gold/12 bg-starlight-abyss/70 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Cache hit rate
          </dt>
          <dd className="mt-0.5 wrap-anywhere text-lg font-semibold text-starlight-teal-soft sm:text-xl">
            <CacheRate series={series} />
          </dd>
        </div>
      </dl>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
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

      <RangeDetailTable series={series} mode={mode} range={range} />
    </div>
  );
}

export function RollingUsageSection({
  range,
  window,
  mode,
  loading = false,
  updating = false,
  error = null,
  onWindowChange,
}: {
  range: UsageRangeResponse | null;
  window: UsageRangeWindow;
  mode: NumberMode;
  loading?: boolean;
  updating?: boolean;
  error?: string | null;
  onWindowChange: (window: UsageRangeWindow) => void;
}) {
  return (
    <Card
      className={cn("min-w-0 gap-3 py-4 transition-opacity duration-150", updating && "opacity-65")}
    >
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <CardTitle
              style={{ fontFamily: "var(--font-display)" }}
              className="flex items-center gap-2 text-sm tracking-[0.1em] text-starlight-parchment sm:text-base"
            >
              <span className="flex size-6 items-center justify-center rounded-full border border-teal-300/40 bg-teal-400/15 text-teal-200">
                <Activity className="size-3.5" aria-hidden="true" />
              </span>
              Rolling usage
            </CardTitle>
            {range ? (
              <span
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                title="Hour-based UTC bucket boundary; includes the current partial hour."
              >
                <Clock3 className="size-3 text-starlight-gold/70" aria-hidden="true" />
                {rangeBoundaryLabel(range)}
              </span>
            ) : null}
          </div>

          <div
            role="group"
            aria-label="Rolling usage window"
            className="inline-flex h-8 items-center rounded-full border border-starlight-gold/30 bg-starlight-night/90 p-0.5 text-xs"
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
      </CardHeader>

      <CardContent className="space-y-3 px-4">
        {range === null ? (
          <p className="rounded-xl border border-dashed border-starlight-gold/20 bg-starlight-abyss/60 px-4 py-6 text-sm text-muted-foreground">
            {loading
              ? "Loading rolling usage…"
              : (error ?? "Rolling usage is unavailable. Monthly breakdown remains available.")}
          </p>
        ) : range.series.length === 0 ? (
          <p className="rounded-xl border border-dashed border-starlight-gold/20 bg-starlight-abyss/60 px-4 py-6 text-sm text-muted-foreground">
            No usage in this rolling {rangeWindowLabel(range.window).toLowerCase()} range.
          </p>
        ) : (
          range.series.map((series) => (
            <RangeSeriesPanel
              key={`${series.source}\u0000${series.accounting_basis}\u0000${series.unit_kind}`}
              series={series}
              range={range}
              mode={mode}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
