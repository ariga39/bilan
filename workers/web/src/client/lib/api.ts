import type { BalanceHistoryResponse, BalanceProvider, OverviewResponse } from "@bilan/shared";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: signal ?? null,
  });

  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status})`);
  }

  return (await response.json()) as T;
}

export function fetchOverview(signal?: AbortSignal): Promise<OverviewResponse> {
  return getJson<OverviewResponse>("/api/v1/overview", signal);
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
  return getJson<BalanceHistoryResponse>(`/api/v1/balances/history?${query.toString()}`, signal);
}
