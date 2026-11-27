/* oxlint-disable typescript/no-unsafe-return -- TanStack Router loader/route-context generated types */
import type { BalanceHistoryResponse, BalanceProvider } from "@bilan/shared";
import {
  useIsFetching,
  useQueries,
  useQuery,
  useQueryClient,
  useQueryErrorResetBoundary,
} from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
      // A daily-usage failure must not replace the monthly dashboard or navigation.
      await context.queryClient.prefetchQuery(usageDailyQueryOptions(context.dataSource, search));
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
  const search = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  async function retry(): Promise<void> {
    setRetrying(true);
    queryErrorResetBoundary.reset();
    try {
      queryClient.removeQueries({ queryKey: ["overview"] });
      queryClient.removeQueries({ queryKey: ["usage-daily"] });
      queryClient.removeQueries({ queryKey: ["balance-history"] });
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">bilan</h1>
            <p className="text-xs text-muted-foreground">
              {search.month} · {search.tz}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void retry();
            }}
            disabled={retrying}
          >
            <RefreshCw className={retrying ? "animate-spin" : undefined} />
            Retry
          </Button>
        </header>

        <nav
          aria-label="Dashboard views"
          className="flex w-fit items-center gap-1 rounded-lg border bg-card p-0.5 text-sm"
        >
          <Link
            to="/"
            search={{ ...search, view: "overview" }}
            className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Overview
          </Link>
          <Link
            to="/"
            search={{ ...search, view: "usage" }}
            className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Usage
          </Link>
        </nav>

        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <p className="font-medium text-destructive">Dashboard data could not be loaded.</p>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Navigation remains available. Retry to reload the current selection.
          </p>
        </div>
      </div>
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
    refetchInterval: search.view === "usage" ? 60_000 : false,
  });
  const historyProviders: Array<BalanceProvider> = overview.data
    ? [...new Set(overview.data.balances.map((balance) => balance.provider))]
    : [];
  const historyQueries = useQueries({
    queries: historyProviders.map((provider) => ({
      ...historyQueryOptions(dataSource, provider),
      enabled: search.view === "overview",
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
  const refreshing =
    useIsFetching({ queryKey: ["overview"] }) + useIsFetching({ queryKey: ["usage-daily"] }) > 0;
  const refreshError =
    overview.isError && overview.data
      ? "Overview refresh failed. Showing cached data."
      : daily.isError && daily.data
        ? "Daily usage refresh failed. Showing cached data."
        : null;

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
        historyQueries.some((query) => query.isError) ? "Balance history refresh failed." : null
      }
      refreshError={refreshError}
      refreshing={refreshing}
      dailyLoading={daily.isPending}
      dailyError={
        daily.isError && daily.data === undefined
          ? "Daily usage could not be loaded. Monthly totals remain available."
          : null
      }
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
