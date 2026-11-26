import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import { DEFAULT_TIMEZONE } from "@bilan/shared";
import {
  balanceHistoryResponseSchema,
  overviewResponseSchema,
  usageDailyResponseSchema,
} from "@bilan/shared/schemas";

interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function getJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: signal ?? null,
  });

  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status})`);
  }

  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error("The read API returned an unexpected response.");
  }
  return parsed.data;
}

function usagePath(base: string, timezone: string, month: string): string {
  const query = new URLSearchParams({ tz: timezone, month });
  return `${base}?${query.toString()}`;
}

export function fetchOverview(
  signal?: AbortSignal,
  timezone = DEFAULT_TIMEZONE,
  month?: string,
): Promise<OverviewResponse> {
  const query = new URLSearchParams({ tz: timezone });
  if (month) {
    query.set("month", month);
  }
  return getJson(`/api/v1/overview?${query.toString()}`, overviewResponseSchema, signal);
}

export function fetchUsageDaily(
  timezone: string,
  month: string,
  signal?: AbortSignal,
): Promise<UsageDailyResponse> {
  return getJson(
    usagePath("/api/v1/usage/daily", timezone, month),
    usageDailyResponseSchema,
    signal,
  );
}

export function fetchBalanceHistory(
  provider: BalanceProvider,
  days = 30,
  signal?: AbortSignal,
): Promise<BalanceHistoryResponse> {
  const query = new URLSearchParams({
    provider,
    days: String(days),
  });
  return getJson(
    `/api/v1/balances/history?${query.toString()}`,
    balanceHistoryResponseSchema,
    signal,
  );
}
