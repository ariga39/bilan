import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import { queryOptions } from "@tanstack/react-query";

import type { DashboardSearch } from "../search";

export interface UsageInput {
  timezone: string;
  month: string;
}

export interface DashboardDataSource {
  overview(input: UsageInput): Promise<OverviewResponse>;
  daily(input: UsageInput): Promise<UsageDailyResponse>;
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
