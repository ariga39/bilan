import { currentMonthInTimeZone, localDateInTimeZone, monthRangeUtc } from "@bilan/shared";

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
