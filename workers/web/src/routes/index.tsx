/* oxlint-disable typescript/no-unsafe-return -- TanStack Router loader/route-context generated types */
import type { BalanceHistoryResponse, BalanceProvider } from "@bilan/shared";
import { useIsFetching, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Dashboard, DashboardLoading } from "@/Dashboard";
import {
  historyQueryOptions,
  overviewQueryOptions,
  usageDailyQueryOptions,
} from "../query/dashboard";
import type { DashboardSearch } from "../search";
import { validateDashboardSearch } from "../search";

export const Route = createFileRoute("/")({
  validateSearch: (search: unknown): DashboardSearch => validateDashboardSearch(search),
  loaderDeps: ({ search }) => ({
    view: search.view,
    tz: search.tz,
    month: search.month,
  }),
  loader: async ({ context, deps }) => {
    const search = { view: deps.view, tz: deps.tz, month: deps.month };
    await context.queryClient.query(overviewQueryOptions(context.dataSource, search));
    if (deps.view === "usage") {
      await context.queryClient.query(usageDailyQueryOptions(context.dataSource, search));
    }
  },
  headers: () => ({ "Cache-Control": "private, no-store" }),
  pendingComponent: PendingDashboard,
  errorComponent: DashboardError,
  component: DashboardRoute,
});

function PendingDashboard() {
  return <DashboardLoading />;
}

function DashboardError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The read API is unavailable.";
  return (
    <div className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p className="font-medium text-destructive">Dashboard data could not be loaded.</p>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function DashboardRoute() {
  const search = Route.useSearch();
  const { dataSource } = Route.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const overview = useQuery({
    ...overviewQueryOptions(dataSource, search),
    refetchInterval: 60_000,
  });
  const daily = useQuery({
    ...usageDailyQueryOptions(dataSource, search),
    enabled: search.view === "usage",
  });
  const historyProviders: Array<BalanceProvider> = overview.data
    ? [...new Set(overview.data.balances.map((balance) => balance.provider))]
    : [];
  const historyQueries = useQueries({
    queries: historyProviders.map((provider) => historyQueryOptions(dataSource, provider)),
  });
  const histories: Partial<Record<BalanceProvider, BalanceHistoryResponse>> = {};
  historyProviders.forEach((provider, index) => {
    const query = historyQueries[index];
    if (query?.data !== undefined) {
      histories[provider] = query.data;
    }
  });
  const refreshing =
    useIsFetching({ queryKey: ["overview"] }) + useIsFetching({ queryKey: ["usage-daily"] }) > 0;

  if (overview.data === undefined) {
    return <PendingDashboard />;
  }

  return (
    <Dashboard
      search={search}
      overview={overview.data}
      daily={daily.data ?? null}
      histories={histories}
      historyLoading={historyQueries.some((query) => query.isPending)}
      historyError={
        historyQueries.some((query) => query.isError)
          ? "Balance history could not be loaded."
          : null
      }
      refreshing={refreshing}
      onNavigate={(next) => {
        void navigate({
          to: "/",
          search: (previous) => ({ ...previous, ...next }),
        });
      }}
      onRefresh={() => {
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
        void queryClient.invalidateQueries({ queryKey: ["usage-daily"] });
        void queryClient.invalidateQueries({ queryKey: ["balance-history"] });
      }}
    />
  );
}
