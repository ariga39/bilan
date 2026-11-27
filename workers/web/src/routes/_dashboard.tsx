import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { DashboardHeader } from "@/components/dashboard-shell";
import { overviewQueryOptions } from "../query/dashboard";
import { validateDashboardSearch } from "../search";

export const Route = createFileRoute("/_dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { dataSource } = Route.useRouteContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const rawSearch = useRouterState({ select: (state) => state.location.search });
  const search = validateDashboardSearch(rawSearch);
  const view = pathname === "/usage" ? "usage" : "overview";
  const queryClient = useQueryClient();
  const overview = useQuery({
    ...overviewQueryOptions(dataSource, search),
    // The header only mirrors the route loader's cached overview; it must not
    // start a second fetch while a route error is on screen.
    enabled: false,
  });
  const overviewFetching = useIsFetching({ queryKey: ["overview"] });
  const routeFetching = useIsFetching({
    queryKey: view === "usage" ? ["usage-daily"] : ["balance-history"],
  });
  const refreshing = overviewFetching + routeFetching > 0;

  return (
    <div className="min-h-screen overflow-x-clip">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 lg:px-8">
        <DashboardHeader
          view={view}
          search={search}
          generatedAt={overview.data?.generated_at ?? null}
          refreshing={refreshing}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: ["overview"] });
            void queryClient.invalidateQueries({
              queryKey: view === "usage" ? ["usage-daily"] : ["balance-history"],
            });
          }}
        />
        <main className="flex min-w-0 flex-col gap-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
