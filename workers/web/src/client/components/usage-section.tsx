import type { MonthlyUsage, UsageDailyResponse } from "@bilan/shared";
import { BarChart3, CalendarDays, Clock3, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/format";
import { monthLabel, monthRangeLabel, sourceLabel, usagePeriod } from "@/lib/usage";
import type { NumberMode } from "@/lib/usage-summary";
import { groupDailyRows, groupMonthlyRows } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { DailyTrendCard } from "./usage-chart";
import { MonthlyBreakdown, Summary } from "./usage-tables";

const TIMEZONES = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "America/New_York", label: "America/New_York" },
];

const SELECT_CLASS =
  "h-8 rounded-full border border-starlight-gold/30 bg-starlight-night px-3 text-xs text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
  const monthGroups = usage ? groupMonthlyRows(usage.rows) : [];
  const allDailyGroups = selectedDaily ? groupDailyRows(selectedDaily.rows) : [];
  const todayRows =
    period.isCurrentMonth && selectedDaily
      ? selectedDaily.rows.filter((row) => row.date === period.today)
      : [];
  const todayGroups = groupDailyRows(todayRows);
  const periodName = period.isCurrentMonth ? "This month" : "Historical month";
  const dailyUnavailable = selectedDaily === null;

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2.5 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-base tracking-[0.08em] text-starlight-parchment"
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
              className="inline-flex h-8 items-center rounded-full border border-starlight-gold/30 bg-starlight-night p-0.5 text-xs"
            >
              <button
                type="button"
                aria-pressed={numberMode === "compact"}
                className={cn(
                  "rounded-full px-2.5 py-0.5 transition-all",
                  numberMode === "compact"
                    ? "bg-gradient-to-r from-starlight-rose to-starlight-violet font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
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
                    ? "bg-gradient-to-r from-starlight-rose to-starlight-violet font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
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
