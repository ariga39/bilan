export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/u;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isValidMonth(value: string): boolean {
  const match = MONTH_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function currentMonthInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new Error("Could not resolve the current month in the requested timezone");
  }
  return `${year}-${month}`;
}

function utcOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Missing ${type} while resolving timezone offset`);
    }
    return Number(part.value);
  };
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function localMidnightUtc(year: number, monthIndex: number, day: number, timeZone: string): number {
  const target = Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = target - utcOffsetMs(new Date(guess), timeZone);
    if (next === guess) {
      break;
    }
    guess = next;
  }
  return guess;
}

export interface MonthRange {
  start: string;
  end: string;
}

/** UTC instants for the inclusive start and exclusive end of a local month. */
export function monthRangeUtc(month: string, timeZone: string): MonthRange {
  if (!isValidMonth(month) || !isValidTimeZone(timeZone)) {
    throw new Error("Invalid month or timezone");
  }
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const monthIndex = monthNumber - 1;
  const start = localMidnightUtc(year, monthIndex, 1, timeZone);
  const end =
    monthIndex === 11
      ? localMidnightUtc(year + 1, 0, 1, timeZone)
      : localMidnightUtc(year, monthIndex + 1, 1, timeZone);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** The local calendar date (`YYYY-MM-DD`) of a UTC timestamp in a timezone. */
export function localDateInTimeZone(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Could not resolve the local date");
  }
  return `${year}-${month}-${day}`;
}
