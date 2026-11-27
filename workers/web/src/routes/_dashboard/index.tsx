import type { BalanceHistoryResponse, BalanceProvider } from "@bilan/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { DashboardErrorNotice, DashboardPending } from "@/components/dashboard-shell";
import { OverviewDashboard } from "@/overview";
import { historyQueryOptions, overviewQueryOptions } from "../../query/dashboard";
import type { OverviewSearch } from "../../search";
import { validateOverviewSearch } from "../../search";

export const Route = createFileRoute("/_dashboard/")({
  validateSearch: (search: unknown): OverviewSearch => validateOverviewSearch(search),
  beforeLoad: ({ search }) => {
    if (search.view === "usage") {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router redirect is a control-flow signal
      throw redirect({
        to: "/usage",
        search: { tz: search.tz, month: search.month },
        replace: true,
      });
    }
  },
  loaderDeps: ({ search }) => ({ tz: search.tz, month: search.month }),
  loader: async ({ context, deps }) => {
    await context.queryClient.query(overviewQueryOptions(context.dataSource, deps));
  },
  headers: () => ({ "Cache-Control": "private, no-store" }),
  pendingComponent: () => <DashboardPending label="Loading overview…" />,
  errorComponent: OverviewError,
  component: OverviewRoute,
});

function OverviewError({ error }: { error: unknown }) {
  return <DashboardErrorNotice error={error} queryKeys={["overview", "balance-history"]} />;
}

function OverviewRoute() {
  const search = Route.useSearch();
  const { dataSource } = Route.useRouteContext();
  const navigate = useNavigate();
  const overview = useQuery({
    ...overviewQueryOptions(dataSource, search),
    refetchInterval: 60_000,
  });
  const historyProviders: Array<BalanceProvider> = overview.data
    ? [...new Set(overview.data.balances.map((balance) => balance.provider))]
    : [];
  const historyQueries = useQueries({
    queries: historyProviders.map((provider) => ({
      ...historyQueryOptions(dataSource, provider),
      refetchInterval: 60_000,
    })),
  });
  const histories: Partial<Record<BalanceProvider, BalanceHistoryResponse>> = {};
  historyProviders.forEach((provider, index) => {
    const query = historyQueries[index];
    if (query?.data !== undefined) {
      histories[provider] = query.data;
    }
  });
  const refreshError =
    overview.isError && overview.data ? "Overview refresh failed. Showing cached data." : null;

  if (overview.data === undefined) {
    return <DashboardPending label="Loading overview…" />;
  }

  return (
    <OverviewDashboard
      search={search}
      overview={overview.data}
      histories={histories}
      historyLoading={historyQueries.some((query) => query.isPending)}
      historyError={
        historyQueries.some((query) => query.isError) ? "Balance history refresh failed." : null
      }
      refreshError={refreshError}
      onOpenUsage={() => {
        void navigate({
          to: "/usage",
          search: { tz: search.tz, month: search.month },
        });
      }}
    />
  );
}
