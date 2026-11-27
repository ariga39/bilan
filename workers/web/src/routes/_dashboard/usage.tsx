/* oxlint-disable typescript/no-unsafe-assignment -- TanStack Router generated search types */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DashboardErrorNotice, DashboardPending } from "@/components/dashboard-shell";
import { UsageDashboard } from "@/usage";
import { overviewQueryOptions, usageDailyQueryOptions } from "../../query/dashboard";
import type { DashboardSearch } from "../../search";
import { validateDashboardSearch } from "../../search";

export const Route = createFileRoute("/_dashboard/usage")({
  validateSearch: (search: unknown): DashboardSearch => validateDashboardSearch(search),
  loaderDeps: ({ search }) => ({ tz: search.tz, month: search.month }),
  loader: async ({ context, deps }) => {
    await context.queryClient.query(overviewQueryOptions(context.dataSource, deps));
    // A daily-usage failure must not replace the monthly route or navigation.
    await context.queryClient.prefetchQuery(usageDailyQueryOptions(context.dataSource, deps));
  },
  headers: () => ({ "Cache-Control": "private, no-store" }),
  pendingComponent: () => <DashboardPending label="Loading usage…" />,
  errorComponent: UsageError,
  component: UsageRoute,
});

function UsageError({ error }: { error: unknown }) {
  return <DashboardErrorNotice error={error} queryKeys={["overview", "usage-daily"]} />;
}

function UsageRoute() {
  const search = Route.useSearch();
  const { dataSource } = Route.useRouteContext();
  const navigate = useNavigate();
  const overview = useQuery({
    ...overviewQueryOptions(dataSource, search),
    refetchInterval: 60_000,
  });
  const daily = useQuery({
    ...usageDailyQueryOptions(dataSource, search),
    refetchInterval: 60_000,
  });
  const refreshError =
    overview.isError && overview.data
      ? "Overview refresh failed. Showing cached data."
      : daily.isError && daily.data
        ? "Daily usage refresh failed. Showing cached data."
        : null;

  if (overview.data === undefined) {
    return <DashboardPending label="Loading usage…" />;
  }

  return (
    <UsageDashboard
      search={search}
      overview={overview.data}
      daily={daily.data ?? null}
      dailyLoading={daily.isPending}
      dailyError={
        daily.isError && daily.data === undefined
          ? "Daily usage could not be loaded. Monthly totals remain available."
          : null
      }
      refreshError={refreshError}
      onTimezoneChange={(tz) => {
        void navigate({ to: "/usage", search: { ...search, tz } });
      }}
      onMonthChange={(month) => {
        void navigate({ to: "/usage", search: { ...search, month } });
      }}
    />
  );
}
