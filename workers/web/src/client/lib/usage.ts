import {
  HOUR_MS,
  currentMonthInTimeZone,
  localDateInTimeZone,
  monthRangeUtc,
  usageRangeHours,
  utcSecondIso,
} from "@bilan/shared";
import type {
  DailyUsageRow,
  UsageRangePoint,
  UsageRangeResponse,
  UsageRangeSeries,
  UsageRangeWindow,
} from "@bilan/shared";

export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)));
}

export function monthRangeLabel(month: string, timezone: string): string {
  const range = monthRangeUtc(month, timezone);
  const start = new Date(range.start);
  const end = new Date(new Date(range.end).getTime() - 1);
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
  return `${format.format(start)} – ${format.format(end)}`;
}

export function usagePeriod(month: string, timezone: string, generatedAt: string) {
  const now = new Date(generatedAt);
  return {
    currentMonth: currentMonthInTimeZone(now, timezone),
    today: localDateInTimeZone(generatedAt, timezone),
    isCurrentMonth: month === currentMonthInTimeZone(now, timezone),
  };
}

export function sourceLabel(source: string): string {
  if (source === "codex") {
    return "Codex";
  }
  if (source === "opencode") {
    return "OpenCode Go";
  }
  return source;
}

export interface DailyTrendPoint {
  day: number;
  date: string;
  requests: number | null;
}

/**
 * Builds one point per local calendar day in the selected month. Days without a
 * daily row stay null so the line breaks instead of bridging missing coverage;
 * an observed zero remains zero.
 */
export function buildDailyTrendPoints(
  rows: ReadonlyArray<Pick<DailyUsageRow, "date" | "unit_count">>,
  month: string,
): Array<DailyTrendPoint> {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year ?? 1970, monthNumber ?? 1, 0)).getUTCDate();
  const byDate = new Map(rows.map((row) => [row.date, row.unit_count]));
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const requests = byDate.get(date);
    return { day, date, requests: requests === undefined ? null : requests };
  });
}

export const RANGE_WINDOW_OPTIONS: ReadonlyArray<{
  value: UsageRangeWindow;
  label: string;
  shortLabel: string;
}> = [
  { value: "24h", label: "Last 24 hours", shortLabel: "24h" },
  { value: "7d", label: "Last 7 days", shortLabel: "7d" },
  { value: "30d", label: "Last 30 days", shortLabel: "30d" },
];

export function rangeWindowLabel(window: UsageRangeWindow): string {
  return RANGE_WINDOW_OPTIONS.find((option) => option.value === window)?.label ?? window;
}

export function rangeBoundaryLabel(
  range: Pick<UsageRangeResponse, "range_start" | "range_end" | "timezone">,
): string {
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: range.timezone,
  });
  const start = new Date(range.range_start);
  const end = new Date(Date.parse(range.range_end) - 1);
  return `${format.format(start)} – ${format.format(end)}`;
}

function hourLabel(timestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(new Date(timestamp));
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export interface RangeTrendPoint {
  key: string;
  label: string;
  requests: number | null;
  input: number | null;
  output: number | null;
  cacheHitRate: number | null;
}

function trendPoint(point: UsageRangePoint): Omit<RangeTrendPoint, "label"> {
  return {
    key: point.start,
    requests: point.unit_count,
    input: point.input_tokens,
    output: point.output_tokens,
    cacheHitRate: point.cache_hit_rate,
  };
}

/**
 * Expands observed points across the bounded range so missing hours/days stay
 * null gaps instead of being silently connected or filled with zero.
 */
export function buildRangeTrendPoints(
  series: UsageRangeSeries,
  range: Pick<UsageRangeResponse, "range_start" | "range_end" | "granularity" | "timezone">,
): Array<RangeTrendPoint> {
  const byKey = new Map<string, UsageRangePoint>();
  for (const point of series.points) {
    byKey.set(range.granularity === "hour" ? point.start : point.date, point);
  }

  if (range.granularity === "hour") {
    const points: Array<RangeTrendPoint> = [];
    const start = Date.parse(range.range_start);
    const end = Date.parse(range.range_end);
    for (let timestamp = start; timestamp < end; timestamp += HOUR_MS) {
      const key = utcSecondIso(new Date(timestamp));
      const observed = byKey.get(key);
      points.push({
        ...(observed
          ? trendPoint(observed)
          : { key, requests: null, input: null, output: null, cacheHitRate: null }),
        label: hourLabel(key, range.timezone),
      });
    }
    return points;
  }

  const startDate = localDateInTimeZone(range.range_start, range.timezone);
  const endDate = localDateInTimeZone(
    new Date(Date.parse(range.range_end) - 1).toISOString(),
    range.timezone,
  );
  const points: Array<RangeTrendPoint> = [];
  for (
    let day = Date.parse(`${startDate}T00:00:00Z`);
    day <= Date.parse(`${endDate}T00:00:00Z`);
    day += 86_400_000
  ) {
    const date = new Date(day).toISOString().slice(0, 10);
    const observed = byKey.get(date);
    points.push({
      ...(observed
        ? trendPoint(observed)
        : { key: date, requests: null, input: null, output: null, cacheHitRate: null }),
      label: dayLabel(date),
    });
  }
  return points;
}

export function formatCacheHitRate(rate: number | null): string {
  if (rate === null) {
    return "—";
  }
  const percent = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function rangeWindowHoursLabel(window: UsageRangeWindow): string {
  const hours = usageRangeHours(window);
  return `${hours} hourly ${hours === 1 ? "bucket" : "buckets"}`;
}
