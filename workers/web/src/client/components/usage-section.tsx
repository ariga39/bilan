import type {
  DailyUsageRow,
  MonthlyUsage,
  UsageBreakdownRow,
  UsageCounters,
  UsageDailyResponse,
  UsageTokenColumn,
} from "@bilan/shared";
import { BarChart3, CalendarDays, CheckCircle2, Clock3, TriangleAlert } from "lucide-react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber } from "@/lib/format";
import { monthLabel, monthRangeLabel, sourceLabel, usagePeriod } from "@/lib/usage";
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
  "h-9 rounded-md border bg-card px-2.5 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

interface Coverage {
  isPartial: boolean;
  gaps: number;
  columns: Array<UsageTokenColumn>;
}

interface SummaryGroup {
  key: string;
  source: string;
  accountingBasis: string;
  unitKind: string;
  requests: number;
  input: TokenAggregate;
  output: TokenAggregate;
  coverage: Coverage;
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
  if (actorKind === "") {
    return "Actor";
  }
  return actorKind;
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

function summarizeCoverage(
  rows: ReadonlyArray<{
    is_partial: boolean;
    coverage_gaps: number;
    partial_columns: Array<UsageTokenColumn>;
  }>,
): Coverage {
  const columns = new Set<UsageTokenColumn>();
  let gaps = 0;
  for (const row of rows) {
    gaps += row.coverage_gaps;
    for (const column of row.partial_columns) {
      columns.add(column);
    }
  }
  return {
    isPartial: gaps > 0 || columns.size > 0,
    gaps,
    columns: [...columns],
  };
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
  return {
    key: summaryGroupKey(row),
    source: row.source,
    accountingBasis: row.accounting_basis,
    unitKind: row.unit_kind,
    requests: 0,
    input: { value: null, counted: 0, units: 0 },
    output: { value: null, counted: 0, units: 0 },
    coverage: { isPartial: false, gaps: 0, columns: [] },
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

function monthlyGroups(rows: Array<UsageBreakdownRow>): Array<SummaryGroup> {
  const groups = new Map<string, SummaryGroup>();
  for (const row of rows) {
    const key = summaryGroupKey(row);
    const group = groups.get(key) ?? emptyGroup(row);
    group.monthlyRows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.requests = group.monthlyRows.reduce((total, row) => total + row.unit_count, 0);
    group.input = aggregateToken(group.monthlyRows, "input_tokens", "input_counted");
    group.output = aggregateToken(group.monthlyRows, "output_tokens", "output_counted");
    group.coverage = summarizeCoverage(group.monthlyRows);
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
    group.requests = group.dailyRows.reduce((total, row) => total + row.unit_count, 0);
    group.input = aggregateToken(group.dailyRows, "input_tokens", "input_counted");
    group.output = aggregateToken(group.dailyRows, "output_tokens", "output_counted");
    group.coverage = summarizeCoverage(group.dailyRows);
  }
  return sortGroups([...groups.values()]);
}

function TokenValue({ aggregate }: { aggregate: TokenAggregate }) {
  if (aggregate.value === null) {
    return <span className="text-xs text-muted-foreground">Not reported</span>;
  }
  const partial = aggregate.counted < aggregate.units;
  return (
    <span className={cn("tabular-nums", partial && "text-amber-700")}>
      {formatNumber(aggregate.value)}
      {partial ? (
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">
          ({aggregate.counted}/{aggregate.units})
        </span>
      ) : null}
    </span>
  );
}

function CoverageBadge({ coverage }: { coverage: Coverage }) {
  if (!coverage.isPartial) {
    return (
      <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
        <CheckCircle2 />
        Complete
      </Badge>
    );
  }
  const detail =
    coverage.gaps > 0
      ? `${coverage.gaps} gap${coverage.gaps === 1 ? "" : "s"}`
      : `${coverage.columns.length} column${coverage.columns.length === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
        <TriangleAlert />
        Partial
      </Badge>
      <span className="text-[10px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function GroupHeading({ group }: { group: SummaryGroup }) {
  return (
    <div className="min-w-0">
      <p className="font-medium">{sourceLabel(group.source)}</p>
      <p className="truncate text-xs text-muted-foreground">
        {group.accountingBasis} · {group.unitKind}
      </p>
    </div>
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
          className="inline-flex flex-wrap items-center gap-1.5 rounded-full border bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <Clock3 className="size-3" />
          {sourceLabel(source.source)}
          {source.latest_bucket_start
            ? ` · data through ${formatDateTime(source.latest_bucket_start)} · ${formatAge(
                source.data_age_seconds,
              )}`
            : " · no buckets"}
          {source.is_stale ? (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
              Delayed
            </Badge>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function SummaryCards({ groups, label }: { groups: Array<SummaryGroup>; label: string }) {
  return (
    <div className="grid gap-2 md:hidden" aria-label={label}>
      {groups.map((group) => (
        <div key={group.key} className="min-w-0 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-2">
            <GroupHeading group={group} />
            <CoverageBadge coverage={group.coverage} />
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-[11px] text-muted-foreground">Requests</dt>
              <dd className="font-semibold tabular-nums">{formatNumber(group.requests)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Input</dt>
              <dd>
                <TokenValue aggregate={group.input} />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Output</dt>
              <dd>
                <TokenValue aggregate={group.output} />
              </dd>
            </div>
          </dl>
        </div>
      ))}
    </div>
  );
}

function SummaryTable({ groups, label }: { groups: Array<SummaryGroup>; label: string }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border md:block">
      <table className="w-full min-w-[44rem] text-sm" aria-label={label}>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Accounting basis</th>
            <th className="px-3 py-2 font-medium">Unit</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            <th className="px-3 py-2 text-right font-medium">Input</th>
            <th className="px-3 py-2 text-right font-medium">Output</th>
            <th className="px-3 py-2 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.key} className="border-t">
              <td className="px-3 py-2 font-medium">{sourceLabel(group.source)}</td>
              <td className="px-3 py-2 text-xs">{group.accountingBasis}</td>
              <td className="px-3 py-2 text-xs">{group.unitKind}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(group.requests)}</td>
              <td className="px-3 py-2 text-right">
                <TokenValue aggregate={group.input} />
              </td>
              <td className="px-3 py-2 text-right">
                <TokenValue aggregate={group.output} />
              </td>
              <td className="px-3 py-2">
                <CoverageBadge coverage={group.coverage} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Summary({ groups, label }: { groups: Array<SummaryGroup>; label: string }) {
  return (
    <>
      <SummaryCards groups={groups} label={`${label} (mobile)`} />
      <SummaryTable groups={groups} label={label} />
    </>
  );
}

function DailyDetailTable({ group }: { group: SummaryGroup }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full min-w-[64rem] text-sm"
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
            <th className="px-3 py-2 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {group.dailyRows.map((row) => (
            <tr key={`${group.key}-${row.date}`} className="border-t">
              <td className="px-3 py-2 font-mono text-xs">{row.date}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.unit_count)}</td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-2 text-right">
                  <TokenValue
                    aggregate={{
                      value: row[column.value],
                      counted: row[column.counted],
                      units: row.unit_count,
                    }}
                  />
                </td>
              ))}
              <td className="px-3 py-2">
                <CoverageBadge coverage={summarizeCoverage([row])} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyTrendCard({ group }: { group: SummaryGroup }) {
  const points = group.dailyRows.map((row) => ({
    date: row.date,
    requests: row.unit_count,
  }));
  return (
    <div className="min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <GroupHeading group={group} />
        <CoverageBadge coverage={group.coverage} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Requests <strong className="text-foreground">{formatNumber(group.requests)}</strong>
        </span>
        <span>
          Input <TokenValue aggregate={group.input} />
        </span>
        <span>
          Output <TokenValue aggregate={group.output} />
        </span>
      </div>
      <div
        className="mt-3 h-44 w-full"
        role="img"
        aria-label={`Daily requests trend for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={20}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              width={44}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <Tooltip
              labelFormatter={String}
              formatter={(value) => [formatNumber(Number(value)), "Requests"]}
              contentStyle={{
                borderRadius: "var(--radius-md)",
                borderColor: "var(--border)",
                fontSize: "12px",
              }}
            />
            <Line
              type="monotone"
              dataKey="requests"
              name="Requests"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={points.length === 1 ? { r: 3 } : false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 rounded-md border bg-card px-2.5 py-2 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">
          Exact daily values
        </summary>
        <div className="mt-2">
          <DailyDetailTable group={group} />
        </div>
      </details>
    </div>
  );
}

function MonthlyDetailTable({ group }: { group: SummaryGroup }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full min-w-[64rem] text-sm"
        aria-label={`Monthly detail for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Actor</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Effort</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            {TOKEN_COLUMNS.map((column) => (
              <th key={column.value} className="px-3 py-2 text-right font-medium">
                {column.label}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {group.monthlyRows.map((row) => (
            <tr
              key={`${group.key}-${row.actor_kind}-${row.actor_id}-${row.model}-${row.effort}`}
              className="border-t"
            >
              <td className="px-3 py-2">
                <p className="font-medium">{row.actor_id}</p>
                <p className="text-[10px] text-muted-foreground">{actorLabel(row.actor_kind)}</p>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{row.model}</td>
              <td className="px-3 py-2">
                {row.effort === "" ? (
                  <span className="text-muted-foreground">Unlabelled</span>
                ) : (
                  row.effort
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.unit_count)}</td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-2 text-right">
                  <TokenValue
                    aggregate={{
                      value: row[column.value],
                      counted: row[column.counted],
                      units: row.unit_count,
                    }}
                  />
                </td>
              ))}
              <td className="px-3 py-2">
                <CoverageBadge coverage={summarizeCoverage([row])} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyBreakdown({ groups }: { groups: Array<SummaryGroup> }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">
        Monthly breakdown by machine, identity, model and effort
      </h3>
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No monthly dimension rows for this selection.
        </div>
      ) : (
        groups.map((group) => (
          <details key={group.key} className="min-w-0 rounded-lg border bg-card px-3 py-2">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
              <GroupHeading group={group} />
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {formatNumber(group.requests)} requests
                <CoverageBadge coverage={group.coverage} />
              </span>
            </summary>
            <div className="mt-2">
              <MonthlyDetailTable group={group} />
            </div>
          </details>
        ))
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
    <Card>
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-muted-foreground" />
            Token usage
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
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
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {periodName} · {monthLabel(month)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {period.isCurrentMonth ? `Today ${period.today}` : "Today outside this range"}
          </span>
          <span aria-hidden="true">·</span>
          <span>{timezone}</span>
        </p>
        <details className="rounded-md border bg-card px-2.5 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground">
            Period &amp; data details
          </summary>
          <div className="mt-2 space-y-2 text-muted-foreground">
            <p>
              {periodName} · {monthLabel(month)} · {monthRangeLabel(month, timezone)} · {timezone}
            </p>
            <p>
              {usage?.latest_bucket_start
                ? `Latest bucket across sources: ${formatDateTime(
                    usage.latest_bucket_start,
                  )} · ${formatAge(usage.data_age_seconds)}`
                : "No usage buckets for this selection."}
            </p>
            {usage ? <SourceFreshness usage={usage} /> : null}
            <p>
              Each source, accounting basis and unit kind stays separate. Cached, reasoning and
              other token components are listed individually and never added into the input/output
              totals.
            </p>
          </div>
        </details>
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
            <p className="mt-1 text-sm text-muted-foreground">
              Old rows from another month or timezone are intentionally hidden.
            </p>
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
                  <Summary groups={todayGroups} label="Today's usage summary" />
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
                <Summary groups={monthGroups} label={`${periodName} usage summary`} />
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                  <p className="font-medium">No token usage for this month</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A row appears after debitmetre or orihsus pushes a complete UTC-hour bucket that
                    falls inside the selected timezone month. AGY has no token usage rows, so it is
                    never shown as zero.
                  </p>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Daily trend</h3>
                <span className="text-xs text-muted-foreground">
                  {periodName} · {monthLabel(month)} · {monthRangeLabel(month, timezone)}
                </span>
              </div>
              {dailyUnavailable ? (
                <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  {dailyLoading
                    ? "Loading daily usage…"
                    : (dailyError ?? "Daily usage for this selection is unavailable.")}
                </p>
              ) : allDailyGroups.length > 0 ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {allDailyGroups.map((group) => (
                    <DailyTrendCard key={group.key} group={group} />
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  No daily usage for this month.
                </p>
              )}
            </section>

            {monthGroups.length > 0 ? <MonthlyBreakdown groups={monthGroups} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
