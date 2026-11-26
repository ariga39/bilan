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

export function formatChartDate(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
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
