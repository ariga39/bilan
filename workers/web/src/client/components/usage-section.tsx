import type {
  DailyUsageRow,
  MonthlyUsage,
  UsageBreakdownRow,
  UsageCounters,
  UsageDailyResponse,
  UsageTokenColumn,
} from "@bilan/shared";
import { BarChart3, CalendarDays, Clock3, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatCompactNumber, formatDateTime, formatNumber } from "@/lib/format";
import {
  buildDailyTrendPoints,
  monthLabel,
  monthRangeLabel,
  sourceLabel,
  usagePeriod,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

const TOKEN_COLUMNS: ReadonlyArray<{
  value: UsageTokenColumn;
  counted: CountedColumn;
  label: string;
}> = [
  { value: "input_tokens", counted: "input_counted", label: "Input" },
  { value: "cached_tokens", counted: "cached_counted", label: "Cached" },
  { value: "uncached_tokens", counted: "uncached_counted", label: "Uncached" },
  { value: "cache_write_tokens", counted: "cache_write_counted", label: "Cache write" },
  { value: "output_tokens", counted: "output_counted", label: "Output" },
  { value: "reasoning_tokens", counted: "reasoning_counted", label: "Reasoning" },
];

const TIMEZONES = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "America/New_York", label: "America/New_York" },
];

const SELECT_CLASS =
  "h-8 rounded-full border border-[#f5d08a]/30 bg-[#140f2c] px-3 text-xs text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

type NumberMode = "compact" | "exact";

interface TokenAggregate {
  value: number | null;
  counted: number;
  units: number;
}

type CountedColumn =
  | "input_counted"
  | "cached_counted"
  | "uncached_counted"
  | "cache_write_counted"
  | "output_counted"
  | "reasoning_counted";

interface SummaryGroup {
  key: string;
  source: string;
  accountingBasis: string;
  unitKind: string;
  requests: number;
  gaps: number;
  input: TokenAggregate;
  cached: TokenAggregate;
  output: TokenAggregate;
  reasoning: TokenAggregate;
  monthlyRows: Array<UsageBreakdownRow>;
  dailyRows: Array<DailyUsageRow>;
}

function actorLabel(actorKind: string): string {
  if (actorKind === "identity") {
    return "Identity";
  }
  if (actorKind === "machine") {
    return "Machine";
  }
  return actorKind || "Actor";
}

function formatMetric(value: number, mode: NumberMode): string {
  return mode === "compact" ? formatCompactNumber(value) : formatNumber(value);
}

function aggregateToken<T extends UsageCounters>(
  rows: ReadonlyArray<T>,
  column: UsageTokenColumn,
  counted: CountedColumn,
): TokenAggregate {
  let value: number | null = null;
  let countedTotal = 0;
  let units = 0;
  for (const row of rows) {
    units += row.unit_count;
    countedTotal += row[counted];
    const cell = row[column];
    if (cell !== null) {
      value = (value ?? 0) + cell;
    }
  }
  return { value, counted: countedTotal, units };
}

function summaryGroupKey(row: {
  source: string;
  accounting_basis: string;
  unit_kind: string;
}): string {
  return `${row.source}\u0000${row.accounting_basis}\u0000${row.unit_kind}`;
}

function emptyGroup(row: {
  source: string;
  accounting_basis: string;
  unit_kind: string;
}): SummaryGroup {
  const zero: TokenAggregate = { value: null, counted: 0, units: 0 };
  return {
    key: summaryGroupKey(row),
    source: row.source,
    accountingBasis: row.accounting_basis,
    unitKind: row.unit_kind,
    requests: 0,
    gaps: 0,
    input: zero,
    cached: zero,
    output: zero,
    reasoning: zero,
    monthlyRows: [],
    dailyRows: [],
  };
}

function sortGroups(groups: Array<SummaryGroup>): Array<SummaryGroup> {
  return [...groups].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.accountingBasis.localeCompare(right.accountingBasis) ||
      left.unitKind.localeCompare(right.unitKind),
  );
}

function populateGroupMetrics<T extends UsageCounters & { coverage_gaps: number }>(
  group: SummaryGroup,
  rows: ReadonlyArray<T>,
): void {
  group.requests = rows.reduce((total, row) => total + row.unit_count, 0);
  group.gaps = rows.reduce((total, row) => total + row.coverage_gaps, 0);
  group.input = aggregateToken(rows, "input_tokens", "input_counted");
  group.cached = aggregateToken(rows, "cached_tokens", "cached_counted");
  group.output = aggregateToken(rows, "output_tokens", "output_counted");
  group.reasoning = aggregateToken(rows, "reasoning_tokens", "reasoning_counted");
}

function monthlyGroups(rows: Array<UsageBreakdownRow>): Array<SummaryGroup> {
  const groups = new Map<string, SummaryGroup>();
  for (const row of rows) {
    const key = summaryGroupKey(row);
    const group = groups.get(key) ?? emptyGroup(row);
    group.monthlyRows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.monthlyRows.sort(
      (left, right) =>
        (right.input_tokens ?? -1) - (left.input_tokens ?? -1) ||
        right.unit_count - left.unit_count ||
        left.actor_id.localeCompare(right.actor_id) ||
        left.model.localeCompare(right.model),
    );
    populateGroupMetrics(group, group.monthlyRows);
  }
  return sortGroups([...groups.values()]);
}

function dailyGroups(rows: Array<DailyUsageRow>): Array<SummaryGroup> {
  const groups = new Map<string, SummaryGroup>();
  for (const row of rows) {
    const key = summaryGroupKey(row);
    const group = groups.get(key) ?? emptyGroup(row);
    group.dailyRows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.dailyRows.sort((left, right) => left.date.localeCompare(right.date));
    populateGroupMetrics(group, group.dailyRows);
  }
  return sortGroups([...groups.values()]);
}

function formatCoverageTag(counted: number, total: number): string {
  if (total <= 0) {
    return "";
  }
  if (total < 1000) {
    return `${formatNumber(counted)}/${formatNumber(total)}`;
  }
  return `${Math.round((counted / total) * 1000) / 10}%`;
}

function meteredCaption(
  group: Pick<SummaryGroup, "requests" | "gaps" | "input" | "cached" | "output" | "reasoning">,
): {
  text: string;
  title: string;
} | null {
  if (group.requests === 0) {
    return null;
  }
  const reportedCounteds = [group.input, group.cached, group.output, group.reasoning].flatMap(
    (agg) => (agg.value !== null ? [agg.counted] : []),
  );
  const minCounted = reportedCounteds.length > 0 ? Math.min(...reportedCounteds) : group.requests;
  if (minCounted >= group.requests && group.gaps === 0) {
    return null;
  }
  const pct = Math.round((minCounted / group.requests) * 1000) / 10;
  const text =
    group.gaps > 0 && minCounted >= group.requests
      ? `${formatNumber(group.gaps)} gap${group.gaps === 1 ? "" : "s"}`
      : group.gaps > 0
        ? `${pct}% metered · ${formatNumber(group.gaps)} gap${group.gaps === 1 ? "" : "s"}`
        : `${pct}% metered`;
  return {
    text,
    title: `${formatNumber(minCounted)} of ${formatNumber(group.requests)} requests reported tokens (${formatNumber(group.gaps)} uncounted)`,
  };
}

function TokenCell({ aggregate, mode }: { aggregate: TokenAggregate; mode: NumberMode }) {
  if (aggregate.value === null) {
    return (
      <span className="text-muted-foreground" title="Not reported" aria-label="Not reported">
        —
      </span>
    );
  }
  const isPartial = aggregate.counted < aggregate.units;
  const titleParts = [formatNumber(aggregate.value)];
  if (isPartial) {
    titleParts.push(`${formatNumber(aggregate.counted)}/${formatNumber(aggregate.units)} requests`);
  }
  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums" title={titleParts.join(" · ")}>
      <span>{formatMetric(aggregate.value, mode)}</span>
      {isPartial ? (
        <span
          className="text-[10px] font-normal text-muted-foreground"
          aria-label={`${formatNumber(aggregate.counted)} of ${formatNumber(aggregate.units)} requests metered`}
        >
          {formatCoverageTag(aggregate.counted, aggregate.units)}
        </span>
      ) : null}
    </span>
  );
}

function SourceFreshness({ usage }: { usage: MonthlyUsage }) {
  if (usage.source_freshness.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {usage.source_freshness.map((source) => (
        <span
          key={source.source}
          aria-label={`${sourceLabel(source.source)} freshness`}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <Clock3 className="size-3" />
          {sourceLabel(source.source)}
          {source.latest_bucket_start ? ` · ${formatAge(source.data_age_seconds)}` : " · no data"}
          {source.is_stale ? (
            <Badge
              variant="outline"
              className="rounded-full border-amber-400/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-200"
            >
              Delayed
            </Badge>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function SummaryCards({
  groups,
  label,
  mode,
}: {
  groups: Array<SummaryGroup>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <div className="grid gap-2 md:hidden" aria-label={label}>
      {groups.map((group) => {
        const metered = meteredCaption(group);
        return (
          <div
            key={group.key}
            className="min-w-0 rounded-xl border border-[#f5d08a]/20 bg-[#120d28]/75 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium">{sourceLabel(group.source)}</p>
              {metered ? (
                <span className="text-[11px] text-muted-foreground" title={metered.title}>
                  {metered.text}
                </span>
              ) : null}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Requests</dt>
                <dd
                  className="truncate font-semibold tabular-nums"
                  title={formatNumber(group.requests)}
                >
                  {formatMetric(group.requests, mode)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Input</dt>
                <dd className="truncate font-medium">
                  <TokenCell aggregate={group.input} mode={mode} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Output</dt>
                <dd className="truncate font-medium">
                  <TokenCell aggregate={group.output} mode={mode} />
                </dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function SummaryTable({
  groups,
  label,
  mode,
}: {
  groups: Array<SummaryGroup>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-xl border border-[#f5d08a]/20 bg-[#120d28]/70 md:block">
      <table className="w-full text-sm" aria-label={label}>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            <th className="px-3 py-2 text-right font-medium">Input</th>
            <th className="px-3 py-2 text-right font-medium">Cached</th>
            <th className="px-3 py-2 text-right font-medium">Output</th>
            <th className="px-3 py-2 text-right font-medium">Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const metered = meteredCaption(group);
            return (
              <tr key={group.key} className="border-t">
                <td className="px-3 py-2" title={`${group.accountingBasis} · ${group.unitKind}`}>
                  <span className="font-medium">{sourceLabel(group.source)}</span>
                  {metered ? (
                    <span className="ml-2 text-[11px] text-muted-foreground" title={metered.title}>
                      {metered.text}
                    </span>
                  ) : null}
                </td>
                <td
                  className="px-3 py-2 text-right font-medium tabular-nums"
                  title={formatNumber(group.requests)}
                >
                  {formatMetric(group.requests, mode)}
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.input} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.cached} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.output} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.reasoning} mode={mode} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Summary({
  groups,
  label,
  mode,
}: {
  groups: Array<SummaryGroup>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <>
      <SummaryCards groups={groups} label={`${label} (mobile)`} mode={mode} />
      <SummaryTable groups={groups} label={label} mode={mode} />
    </>
  );
}

function DailyDetailTable({ group, mode }: { group: SummaryGroup; mode: NumberMode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full text-sm"
        aria-label={`Daily exact values for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            {TOKEN_COLUMNS.map((column) => (
              <th key={column.value} className="px-3 py-2 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.dailyRows.map((row) => (
            <tr key={`${group.key}-${row.date}`} className="border-t">
              <td className="px-3 py-1.5 font-mono text-xs">{row.date}</td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                title={formatNumber(row.unit_count)}
              >
                {formatMetric(row.unit_count, mode)}
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-1.5 text-right">
                  <TokenCell
                    aggregate={{
                      value: row[column.value],
                      counted: row[column.counted],
                      units: row.unit_count,
                    }}
                    mode={mode}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyTrendCard({
  group,
  month,
  mode,
}: {
  group: SummaryGroup;
  month: string;
  mode: NumberMode;
}) {
  const points = buildDailyTrendPoints(group.dailyRows, month);
  const metered = meteredCaption(group);
  return (
    <div className="min-w-0 rounded-xl border border-[#f5d08a]/20 bg-[#120d28]/75 p-3">
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
                <stop offset="0%" stopColor={group.source === "opencode" ? "#fef08a" : "#f9a8d4"} />
                <stop
                  offset="55%"
                  stopColor={group.source === "opencode" ? "#f59e0b" : "#ec4899"}
                />
                <stop
                  offset="100%"
                  stopColor={group.source === "opencode" ? "#db2777" : "#7e22ce"}
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
                backgroundColor: "#1b1536",
                borderRadius: "var(--radius-md)",
                borderColor: "rgba(245, 208, 138, 0.35)",
                color: "#f8f3ff",
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
      <details className="mt-2 rounded-lg border border-[#f5d08a]/18 bg-[#0e0a20]/80 px-2.5 py-1.5 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">
          Daily values ({group.dailyRows.length})
        </summary>
        <div className="mt-2">
          <DailyDetailTable group={group} mode={mode} />
        </div>
      </details>
    </div>
  );
}

function MonthlyDetailTable({ group, mode }: { group: SummaryGroup; mode: NumberMode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full text-sm"
        aria-label={`Monthly detail for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">
              {actorLabel(group.monthlyRows[0]?.actor_kind ?? "")}
            </th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Effort</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            {TOKEN_COLUMNS.map((column) => (
              <th key={column.value} className="px-3 py-2 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.monthlyRows.map((row) => (
            <tr
              key={`${group.key}-${row.actor_kind}-${row.actor_id}-${row.model}-${row.effort}`}
              className="border-t"
            >
              <td className="px-3 py-1.5 font-medium">{row.actor_id}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{row.model}</td>
              <td className="px-3 py-1.5 text-xs">
                {row.effort === "" ? <span className="text-muted-foreground">—</span> : row.effort}
              </td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                title={formatNumber(row.unit_count)}
              >
                {formatMetric(row.unit_count, mode)}
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-1.5 text-right">
                  <TokenCell
                    aggregate={{
                      value: row[column.value],
                      counted: row[column.counted],
                      units: row.unit_count,
                    }}
                    mode={mode}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyBreakdown({ groups, mode }: { groups: Array<SummaryGroup>; mode: NumberMode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Breakdown</h3>
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No breakdown rows for this month.
        </div>
      ) : (
        groups.map((group) => {
          const metered = meteredCaption(group);
          return (
            <details
              key={group.key}
              className="min-w-0 rounded-xl border border-[#f5d08a]/20 bg-[#120d28]/75 px-3 py-2"
            >
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{sourceLabel(group.source)}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.monthlyRows.length} rows
                  </span>
                </div>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className="font-medium text-foreground tabular-nums"
                    title={formatNumber(group.requests)}
                  >
                    {formatMetric(group.requests, mode)} req
                  </span>
                  {metered ? <span title={metered.title}>{metered.text}</span> : null}
                </span>
              </summary>
              <div className="mt-2">
                <MonthlyDetailTable group={group} mode={mode} />
              </div>
            </details>
          );
        })
      )}
    </section>
  );
}

export function UsageSection({
  usage,
  daily,
  timezone,
  month,
  generatedAt,
  dailyLoading = false,
  dailyError = null,
  onTimezoneChange,
  onMonthChange,
}: {
  usage: MonthlyUsage | null;
  daily: UsageDailyResponse | null;
  timezone: string;
  month: string;
  generatedAt: string;
  dailyLoading?: boolean;
  dailyError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
}) {
  const [numberMode, setNumberMode] = useState<NumberMode>("compact");
  const period = usagePeriod(month, timezone, generatedAt);
  const timezoneOptions = TIMEZONES.some((option) => option.value === timezone)
    ? TIMEZONES
    : [{ value: timezone, label: timezone }, ...TIMEZONES];
  const selectedDaily =
    daily && daily.timezone === timezone && daily.month === month ? daily : null;
  const attributionApproximate =
    usage?.bucket_attribution === "approximate" ||
    selectedDaily?.bucket_attribution === "approximate";
  const attributionNote = usage?.bucket_attribution_note ?? selectedDaily?.bucket_attribution_note;
  const monthGroups = usage ? monthlyGroups(usage.rows) : [];
  const allDailyGroups = selectedDaily ? dailyGroups(selectedDaily.rows) : [];
  const todayRows =
    period.isCurrentMonth && selectedDaily
      ? selectedDaily.rows.filter((row) => row.date === period.today)
      : [];
  const todayGroups = dailyGroups(todayRows);
  const periodName = period.isCurrentMonth ? "This month" : "Historical month";
  const dailyUnavailable = selectedDaily === null;

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2.5 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-base tracking-[0.08em] text-[#fef3c7]"
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-pink-300/40 bg-pink-400/15 text-pink-200">
              <BarChart3 className="size-3.5" />
            </span>
            Token usage
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Number format"
              className="inline-flex h-8 items-center rounded-full border border-[#f5d08a]/30 bg-[#140f2c] p-0.5 text-xs"
            >
              <button
                type="button"
                aria-pressed={numberMode === "compact"}
                className={cn(
                  "rounded-full px-2.5 py-0.5 transition-all",
                  numberMode === "compact"
                    ? "bg-gradient-to-r from-[#f472b6] to-[#a855f7] font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setNumberMode("compact");
                }}
              >
                Compact
              </button>
              <button
                type="button"
                aria-pressed={numberMode === "exact"}
                className={cn(
                  "rounded-full px-2.5 py-0.5 transition-all",
                  numberMode === "exact"
                    ? "bg-gradient-to-r from-[#f472b6] to-[#a855f7] font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setNumberMode("exact");
                }}
              >
                Exact
              </button>
            </div>
            <label className="sr-only" htmlFor="usage-timezone">
              Timezone
            </label>
            <select
              id="usage-timezone"
              aria-label="Timezone"
              className={SELECT_CLASS}
              value={timezone}
              onChange={(event) => {
                onTimezoneChange(event.target.value);
              }}
            >
              {timezoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="usage-month">
              Month
            </label>
            <input
              id="usage-month"
              aria-label="Month"
              type="month"
              className={SELECT_CLASS}
              value={month}
              onChange={(event) => {
                if (event.target.value) {
                  onMonthChange(event.target.value);
                }
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {periodName} · {monthLabel(month)}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {period.isCurrentMonth ? `Today ${period.today}` : "Today outside this range"}
            </span>
            {usage?.latest_bucket_start ? (
              <>
                <span aria-hidden="true">·</span>
                <span title={formatDateTime(usage.latest_bucket_start)}>
                  Updated {formatAge(usage.data_age_seconds)}
                </span>
              </>
            ) : null}
          </p>
          {usage ? <SourceFreshness usage={usage} /> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {attributionApproximate ? (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <p>
              <span className="font-medium">Approximate bucket boundaries. </span>
              {attributionNote}
            </p>
          </div>
        ) : null}

        {usage === null ? (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="font-medium">Usage could not be loaded</p>
          </div>
        ) : (
          <>
            {period.isCurrentMonth ? (
              <section className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-sm font-medium">
                    <CalendarDays className="size-4 text-muted-foreground" />
                    Today · {period.today}
                  </h3>
                  <span className="text-xs text-muted-foreground">{timezone}</span>
                </div>
                {dailyUnavailable ? (
                  <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                    {dailyLoading
                      ? "Loading today's usage…"
                      : (dailyError ??
                        "Today's usage is unavailable because the daily series could not be loaded.")}
                  </p>
                ) : todayGroups.length > 0 ? (
                  <Summary groups={todayGroups} label="Today's usage summary" mode={numberMode} />
                ) : (
                  <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                    No usage rows for today in {timezone}.
                  </p>
                )}
              </section>
            ) : null}

            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-medium">
                  <BarChart3 className="size-4 text-muted-foreground" />
                  {periodName} · {monthLabel(month)}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {monthRangeLabel(month, timezone)}
                </span>
              </div>
              {monthGroups.length > 0 ? (
                <Summary
                  groups={monthGroups}
                  label={`${periodName} usage summary`}
                  mode={numberMode}
                />
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                  <p className="font-medium">No token usage for this month</p>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Daily requests</h3>
              {dailyUnavailable ? (
                <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  {dailyLoading
                    ? "Loading daily usage…"
                    : (dailyError ?? "Daily usage for this selection is unavailable.")}
                </p>
              ) : allDailyGroups.length > 0 ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {allDailyGroups.map((group) => (
                    <DailyTrendCard key={group.key} group={group} month={month} mode={numberMode} />
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  No daily usage for this month.
                </p>
              )}
            </section>

            <MonthlyBreakdown groups={monthGroups} mode={numberMode} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
