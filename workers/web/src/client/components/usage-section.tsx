import type {
  MonthlyUsage,
  UsageDailyResponse,
  UsageRangeResponse,
  UsageRangeWindow,
} from "@bilan/shared";
import { BarChart3, CalendarDays, Clock3, TrendingUp, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { SectionLabel } from "@/components/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/format";
import { monthLabel, monthRangeLabel, sourceLabel, usagePeriod } from "@/lib/usage";
import type { NumberMode } from "@/lib/usage-summary";
import { groupDailyRows, groupMonthlyRows } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { RollingUsageSection } from "./usage-range";
import { DailyTrendCard } from "./usage-chart";
import { MonthlyBreakdown, Summary, sourceAccent } from "./usage-tables";

const TIMEZONES = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "America/New_York", label: "America/New_York" },
];

const CONTROL_CLASS =
  "h-8 rounded-full border border-starlight-gold/30 bg-starlight-night/90 px-3 text-xs text-foreground shadow-xs outline-none transition-colors [color-scheme:dark] hover:border-starlight-gold/50 focus-visible:ring-2 focus-visible:ring-ring";

function SourceFreshness({ usage }: { usage: MonthlyUsage }) {
  if (usage.source_freshness.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-starlight-gold/12 pt-2.5">
      {usage.source_freshness.map((source) => {
        const accent = sourceAccent(source.source);
        return (
          <span
            key={source.source}
            aria-label={`${sourceLabel(source.source)} freshness`}
            className="inline-flex items-center gap-1.5 rounded-full border border-starlight-gold/18 bg-starlight-void/80 px-2.5 py-0.5 text-[11px] text-starlight-violet-muted"
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", accent.dot)} />
            <Clock3 className="size-3 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground/90">{sourceLabel(source.source)}</span>
            <span className="text-muted-foreground">
              {source.latest_bucket_start
                ? ` · ${formatAge(source.data_age_seconds)}`
                : " · no data"}
            </span>
            {source.is_stale ? (
              <Badge
                variant="outline"
                className="rounded-full border-amber-400/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-200"
              >
                Delayed
              </Badge>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function UsageSection({
  usage,
  daily,
  range = null,
  rangeWindow,
  timezone,
  month,
  generatedAt,
  dailyLoading = false,
  dailyError = null,
  rangeLoading = false,
  rangeError = null,
  onTimezoneChange,
  onMonthChange,
  onWindowChange,
}: {
  usage: MonthlyUsage | null;
  daily: UsageDailyResponse | null;
  range?: UsageRangeResponse | null;
  rangeWindow?: UsageRangeWindow;
  timezone: string;
  month: string;
  generatedAt: string;
  dailyLoading?: boolean;
  dailyError?: string | null;
  rangeLoading?: boolean;
  rangeError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
  onWindowChange?: (window: UsageRangeWindow) => void;
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
    <div className="min-w-0 space-y-5">
      {rangeWindow && onWindowChange ? (
        <RollingUsageSection
          range={range}
          window={rangeWindow}
          mode={numberMode}
          loading={rangeLoading}
          error={rangeError}
          onWindowChange={onWindowChange}
        />
      ) : null}
      <Card className="min-w-0 gap-0 py-3.5">
        <CardContent className="space-y-2.5 px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2
                style={{ fontFamily: "var(--font-display)" }}
                className="flex items-center gap-2 text-base font-semibold tracking-[0.08em] text-starlight-parchment sm:text-lg"
              >
                <span className="flex size-7 items-center justify-center rounded-full border border-pink-300/40 bg-pink-400/15 text-pink-200 shadow-[0_0_12px_rgba(244,114,182,0.3)]">
                  <BarChart3 className="size-3.5" aria-hidden="true" />
                </span>
                Token usage
              </h2>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="font-medium text-starlight-violet-muted">
                  {periodName} · {monthLabel(month)}
                </span>
                <span aria-hidden="true" className="text-starlight-gold/45">
                  ·
                </span>
                <span>
                  {period.isCurrentMonth ? `Today ${period.today}` : "Today outside this range"}
                </span>
                {usage?.latest_bucket_start ? (
                  <>
                    <span aria-hidden="true" className="text-starlight-gold/45">
                      ·
                    </span>
                    <span title={formatDateTime(usage.latest_bucket_start)}>
                      Updated {formatAge(usage.data_age_seconds)}
                    </span>
                  </>
                ) : null}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Number format"
                className="inline-flex h-8 items-center rounded-full border border-starlight-gold/30 bg-starlight-night/90 p-0.5 text-xs"
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
                className={CONTROL_CLASS}
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
                className={CONTROL_CLASS}
                value={month}
                onChange={(event) => {
                  if (event.target.value) {
                    onMonthChange(event.target.value);
                  }
                }}
              />
            </div>
          </div>

          {usage ? <SourceFreshness usage={usage} /> : null}
        </CardContent>
      </Card>

      {attributionApproximate ? (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-400/35 bg-amber-500/12 px-3.5 py-2.5 text-xs text-amber-200"
          role="status"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="leading-relaxed">
            <span className="font-semibold text-amber-100">Approximate bucket boundaries. </span>
            {attributionNote}
          </p>
        </div>
      ) : null}

      {usage === null ? (
        <Card className="border-dashed py-8 text-center">
          <CardContent className="px-4">
            <p className="font-medium text-starlight-parchment">Usage could not be loaded</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {period.isCurrentMonth ? (
            <section className="min-w-0">
              <SectionLabel icon={CalendarDays} title={`Today · ${period.today}`} meta={timezone} />
              {dailyUnavailable ? (
                <p className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-4 text-sm text-muted-foreground">
                  {dailyLoading
                    ? "Loading today's usage…"
                    : (dailyError ??
                      "Today's usage is unavailable because the daily series could not be loaded.")}
                </p>
              ) : todayGroups.length > 0 ? (
                <Summary
                  groups={todayGroups}
                  label="Today's usage summary"
                  mode={numberMode}
                  compact
                />
              ) : (
                <p className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-4 text-sm text-muted-foreground">
                  No usage rows for today in {timezone}.
                </p>
              )}
            </section>
          ) : null}

          <section className="min-w-0">
            <SectionLabel
              icon={BarChart3}
              title={`${periodName} · ${monthLabel(month)}`}
              meta={monthRangeLabel(month, timezone)}
            />
            {monthGroups.length > 0 ? (
              <Summary
                groups={monthGroups}
                label={`${periodName} usage summary`}
                mode={numberMode}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-8 text-center">
                <p className="font-medium text-starlight-parchment">
                  No token usage for this month
                </p>
              </div>
            )}
          </section>

          <section className="min-w-0">
            <SectionLabel icon={TrendingUp} title="Daily requests" />
            {dailyUnavailable ? (
              <p className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-4 text-sm text-muted-foreground">
                {dailyLoading
                  ? "Loading daily usage…"
                  : (dailyError ?? "Daily usage for this selection is unavailable.")}
              </p>
            ) : allDailyGroups.length > 0 ? (
              <div className={cn("grid gap-3.5", allDailyGroups.length > 1 && "lg:grid-cols-2")}>
                {allDailyGroups.map((group) => (
                  <DailyTrendCard key={group.key} group={group} month={month} mode={numberMode} />
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-4 text-sm text-muted-foreground">
                No daily usage for this month.
              </p>
            )}
          </section>

          <MonthlyBreakdown groups={monthGroups} mode={numberMode} />
        </>
      )}
    </div>
  );
}
