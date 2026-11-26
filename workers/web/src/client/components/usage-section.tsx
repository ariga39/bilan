import type {
  DailyUsageRow,
  MonthlyUsage,
  UsageBreakdownRow,
  UsageCounters,
  UsageDailyResponse,
  UsageTokenColumn,
} from "@bilan/shared";
import { BarChart3, CalendarDays, CheckCircle2, Clock3, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const TOKEN_COLUMNS: ReadonlyArray<{
  value: UsageTokenColumn;
  counted:
    | "input_counted"
    | "cached_counted"
    | "uncached_counted"
    | "cache_write_counted"
    | "output_counted"
    | "reasoning_counted";
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

function TokenCell({
  value,
  counted,
  unitCount,
}: {
  value: number | null;
  counted: number;
  unitCount: number;
}) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground">Not reported</span>;
  }
  const partial = counted < unitCount;
  return (
    <span className={cn("tabular-nums", partial && "text-amber-700")}>
      {formatNumber(value)}
      {partial ? (
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">
          ({counted}/{unitCount})
        </span>
      ) : null}
    </span>
  );
}

function TokenCells({ row }: { row: UsageCounters }) {
  return (
    <>
      {TOKEN_COLUMNS.map((column) => (
        <td key={column.value} className="px-3 py-2 text-right">
          <TokenCell
            value={row[column.value]}
            counted={row[column.counted]}
            unitCount={row.unit_count}
          />
        </td>
      ))}
    </>
  );
}

function CoverageBadge({
  isPartial,
  coverageGaps,
  partialColumns,
}: {
  isPartial: boolean;
  coverageGaps: number;
  partialColumns: number;
}) {
  if (!isPartial) {
    return (
      <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
        <CheckCircle2 />
        Complete
      </Badge>
    );
  }
  const detail =
    coverageGaps > 0
      ? `${coverageGaps} gap${coverageGaps === 1 ? "" : "s"}`
      : `${partialColumns} column${partialColumns === 1 ? "" : "s"}`;
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

function sourceLabel(source: string): string {
  if (source === "codex") {
    return "Codex";
  }
  if (source === "opencode") {
    return "OpenCode Go";
  }
  return source;
}

function actorLabel(actorKind: string): string {
  if (actorKind === "identity") {
    return "Identity";
  }
  if (actorKind === "machine") {
    return "Machine";
  }
  return "Actor";
}

interface UsageGroup {
  key: string;
  source: string;
  accountingBasis: string;
  unitKind: string;
  actorKind: string;
  rows: Array<UsageBreakdownRow>;
}

function groupUsageRows(rows: Array<UsageBreakdownRow>): Array<UsageGroup> {
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const key = `${row.source}\u0000${row.accounting_basis}\u0000${row.unit_kind}\u0000${row.actor_kind}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        source: row.source,
        accountingBasis: row.accounting_basis,
        unitKind: row.unit_kind,
        actorKind: row.actor_kind,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.actorKind.localeCompare(right.actorKind) ||
      left.accountingBasis.localeCompare(right.accountingBasis) ||
      left.unitKind.localeCompare(right.unitKind),
  );
}

function MonthlyUsageTable({
  rows,
  actorKind,
  ariaLabel,
}: {
  rows: Array<UsageBreakdownRow>;
  actorKind: string;
  ariaLabel: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[72rem] text-sm" aria-label={ariaLabel}>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{actorLabel(actorKind)}</th>
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
          {rows.map((row) => (
            <tr
              key={`${row.source}-${row.accounting_basis}-${row.unit_kind}-${row.actor_kind}-${row.actor_id}-${row.model}-${row.effort}`}
              className="border-t"
            >
              <td className="px-3 py-2 font-medium">{row.actor_id}</td>
              <td className="px-3 py-2 font-mono text-xs">{row.model}</td>
              <td className="px-3 py-2">
                {row.effort === "" ? (
                  <span className="text-muted-foreground">Unlabelled</span>
                ) : (
                  row.effort
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.unit_count)}</td>
              <TokenCells row={row} />
              <td className="px-3 py-2">
                <CoverageBadge
                  isPartial={row.is_partial}
                  coverageGaps={row.coverage_gaps}
                  partialColumns={row.partial_columns.length}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyUsageTable({ rows }: { rows: Array<DailyUsageRow> }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[64rem] text-sm" aria-label="Daily token usage">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Source</th>
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
          {rows.map((row) => (
            <tr
              key={`${row.date}-${row.source}-${row.accounting_basis}-${row.unit_kind}`}
              className="border-t"
            >
              <td className="px-3 py-2 font-mono text-xs">{row.date}</td>
              <td className="px-3 py-2">{sourceLabel(row.source)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.unit_count)}</td>
              <TokenCells row={row} />
              <td className="px-3 py-2">
                <CoverageBadge
                  isPartial={row.is_partial}
                  coverageGaps={row.coverage_gaps}
                  partialColumns={row.partial_columns.length}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsageSection({
  usage,
  daily,
  timezone,
  month,
  loading = false,
  onTimezoneChange,
  onMonthChange,
}: {
  usage: MonthlyUsage | null;
  daily: UsageDailyResponse | null;
  timezone: string;
  month: string;
  loading?: boolean;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
}) {
  const timezoneOptions = TIMEZONES.some((option) => option.value === timezone)
    ? TIMEZONES
    : [{ value: timezone, label: timezone }, ...TIMEZONES];
  const attributionApproximate =
    usage?.bucket_attribution === "approximate" || daily?.bucket_attribution === "approximate";
  const attributionNote = usage?.bucket_attribution_note ?? daily?.bucket_attribution_note;
  const usageGroups = usage ? groupUsageRows(usage.rows) : [];

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="size-4 text-muted-foreground" />
              Token usage breakdown
            </CardTitle>
            <CardDescription className="mt-1">
              Monthly totals sliced by the selected timezone and calendar month. Codex machines and
              OpenCode Go caller identities are listed separately; token columns are never summed
              across sources or accounting bases. Each column is counted independently, and partial
              columns show how many records reported them.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Timezone
              <select
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
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Month
              <input
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
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {usage ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              Latest bucket across sources: {formatDateTime(usage.latest_bucket_start)} ·{" "}
              {formatAge(usage.data_age_seconds)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              {loading
                ? `Loading usage for ${month} in ${timezone}…`
                : `Usage for ${month} in ${timezone} is unavailable.`}
            </span>
          )}
          <span className="text-muted-foreground/70">
            Heartbeat liveness is shown separately above.
          </span>
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
            <p className="font-medium">
              {loading ? "Loading token usage" : "Usage could not be loaded"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading
                ? "The selected month and timezone will appear after the read API responds."
                : "Old rows from another month or timezone are intentionally hidden."}
            </p>
          </div>
        ) : (
          <>
            {usageGroups.length > 0 ? (
              <div className="space-y-4">
                <h3 className="text-sm font-medium">Monthly breakdown</h3>
                {usageGroups.map((group) => {
                  const freshness = usage.source_freshness.find(
                    (item) => item.source === group.source,
                  );
                  return (
                    <div key={group.key} className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium">{sourceLabel(group.source)}</h4>
                        <Badge variant="outline">{group.accountingBasis}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {group.unitKind} · {actorLabel(group.actorKind)} rows
                        </span>
                        <span
                          aria-label={`${sourceLabel(group.source)} freshness`}
                          className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                        >
                          <Clock3 className="size-3.5" />
                          {freshness?.latest_bucket_start
                            ? `Data through ${formatDateTime(
                                freshness.latest_bucket_start,
                              )} · ${formatAge(freshness.data_age_seconds)}`
                            : "No buckets"}
                          {freshness?.is_stale ? (
                            <Badge
                              variant="outline"
                              className="border-amber-300 bg-amber-50 text-amber-800"
                            >
                              Delayed
                            </Badge>
                          ) : null}
                        </span>
                      </div>
                      <MonthlyUsageTable
                        rows={group.rows}
                        actorKind={group.actorKind}
                        ariaLabel={`${sourceLabel(group.source)} token usage by ${actorLabel(
                          group.actorKind,
                        ).toLowerCase()}, model, and effort`}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center">
                <p className="font-medium">No token usage for this month</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  A row appears after debitmetre or orihsus pushes a complete UTC-hour bucket that
                  falls inside the selected timezone month.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarDays className="size-4 text-muted-foreground" />
                Daily view
              </h3>
              {daily === null ? (
                <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  Daily usage for this selection is unavailable.
                </div>
              ) : daily.rows.length > 0 ? (
                <DailyUsageTable rows={daily.rows} />
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No daily usage for this month.
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
