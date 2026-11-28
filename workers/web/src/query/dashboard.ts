import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
  UsageRangeResponse,
  UsageRangeWindow,
} from "@bilan/shared";
import { queryOptions } from "@tanstack/react-query";

import type { DashboardSearch } from "../search";

export interface UsageInput {
  timezone: string;
  month: string;
}

export interface UsageRangeInput {
  timezone: string;
  window: UsageRangeWindow;
}

export interface DashboardDataSource {
  overview(input: UsageInput): Promise<OverviewResponse>;
  daily(input: UsageInput): Promise<UsageDailyResponse>;
  range(input: UsageRangeInput): Promise<UsageRangeResponse>;
  history(provider: BalanceProvider, days: number): Promise<BalanceHistoryResponse>;
}

export const overviewQueryOptions = (dataSource: DashboardDataSource, search: DashboardSearch) =>
  queryOptions({
    queryKey: ["overview", search.tz, search.month],
    queryFn: () => dataSource.overview({ timezone: search.tz, month: search.month }),
    staleTime: 60_000,
  });

export const usageDailyQueryOptions = (dataSource: DashboardDataSource, search: DashboardSearch) =>
  queryOptions({
    queryKey: ["usage-daily", search.tz, search.month],
    queryFn: () => dataSource.daily({ timezone: search.tz, month: search.month }),
    staleTime: 60_000,
  });

export const usageRangeQueryOptions = (
  dataSource: DashboardDataSource,
  search: DashboardSearch,
) => {
  const window = search.range ?? "24h";
  return queryOptions({
    queryKey: ["usage-range", search.tz, window],
    queryFn: () => dataSource.range({ timezone: search.tz, window }),
    staleTime: 60_000,
  });
};

export const historyQueryOptions = (
  dataSource: DashboardDataSource,
  provider: BalanceProvider,
  days = 30,
) =>
  queryOptions({
    queryKey: ["balance-history", provider, days],
    queryFn: () => dataSource.history(provider, days),
    staleTime: 60_000,
  });
