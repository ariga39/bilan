import type { BalanceHistoryResponse, BalanceProvider, OverviewResponse } from "@bilan/shared";
import { balanceHistoryResponseSchema, overviewResponseSchema } from "@bilan/shared/schemas";

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

export function fetchOverview(signal?: AbortSignal): Promise<OverviewResponse> {
  return getJson("/api/v1/overview", overviewResponseSchema, signal);
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
