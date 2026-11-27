const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

export function formatCurrency(value: number | null, currency: string): string {
  if (value === null) {
    return "Not reported";
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatSignedCurrency(value: number, currency: string): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value), currency)}`;
}

export function formatCompactCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function trimDecimal(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/u, "")
    .replace(/(\.\d*[1-9])0+$/u, "$1");
}

export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000_000_000) {
    const scaled = abs / 1_000_000_000_000;
    return `${sign}${trimDecimal(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}T`;
  }
  if (abs >= 1_000_000_000) {
    const scaled = abs / 1_000_000_000;
    return `${sign}${trimDecimal(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}B`;
  }
  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000;
    return `${sign}${trimDecimal(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}M`;
  }
  if (abs >= 1000) {
    const scaled = abs / 1000;
    return `${sign}${trimDecimal(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}K`;
  }
  return formatNumber(value);
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return "Never";
  }
  if (seconds < 45) {
    return "just now";
  }
  if (seconds < SECONDS_PER_HOUR) {
    const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
    return `${minutes} min ago`;
  }
  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    const minutes = Math.round((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return minutes > 0 ? `${hours} h ${minutes} min ago` : `${hours} h ago`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days} d ago`;
}

export function formatDateTime(timestamp: string | null): string {
  if (timestamp === null) {
    return "Never";
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed)} UTC`;
}

export function formatChartDateMs(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(timestampMs);
}

export function formatSpan(seconds: number | null): string {
  if (seconds === null) {
    return "unknown";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${Math.max(1, Math.round(seconds))} s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
  }
  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    const minutes = Math.round((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.round((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
}

export function formatInterval(seconds: number): string {
  if (seconds % SECONDS_PER_HOUR === 0) {
    const hours = seconds / SECONDS_PER_HOUR;
    return hours === 1 ? "Hourly" : `Every ${hours} h`;
  }
  if (seconds % SECONDS_PER_MINUTE === 0) {
    return `Every ${seconds / SECONDS_PER_MINUTE} min`;
  }
  return `Every ${seconds} s`;
}
