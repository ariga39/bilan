import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildEmptyHistory,
  buildPopulatedDaily,
  buildPopulatedHistory,
  buildPopulatedOverview,
  FIXED_NOW,
  FIXTURE_MONTH,
} from "@/stories/fixtures";
import type { DashboardDataSource, UsageInput } from "../../src/query/dashboard";
import { routeTree } from "../../src/routeTree.gen";

function createRouterFor(
  dataSource: DashboardDataSource,
  view: "overview" | "usage",
  initialSearch = `tz=UTC&month=${FIXTURE_MONTH}`,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient, dataSource },
    history: createMemoryHistory({
      initialEntries: [`${view === "usage" ? "/usage" : "/"}?${initialSearch}`],
    }),
  });
  return { queryClient, router };
}

function rendered(router: ReturnType<typeof createRouterFor>["router"], queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shipped dashboard route", () => {
  it("keeps navigation available and recovers after an initial overview failure", async () => {
    let overviewCalls = 0;
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    const dataSource: DashboardDataSource = {
      overview: async () => {
        overviewCalls += 1;
        if (overviewCalls === 1) {
          throw new Error("first load failed");
        }
        return overview;
      },
      daily: async (input: UsageInput) => buildPopulatedDaily(input.timezone, input.month),
      history: async (provider) => buildPopulatedHistory(provider),
    };
    const { router, queryClient } = createRouterFor(dataSource, "overview");
    rendered(router, queryClient);

    expect(await screen.findByText("Dashboard data could not be loaded.")).toBeTruthy();
    expect(screen.getByText("first load failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Usage" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(overviewCalls).toBeGreaterThan(1);
    });
    expect(
      (await screen.findAllByText("OpenCode Go", {}, { timeout: 3000 })).length,
    ).toBeGreaterThan(0);
    expect(overviewCalls).toBeGreaterThan(1);
    expect(screen.queryByText("Dashboard data could not be loaded.")).toBeNull();
  });

  it("keeps monthly usage and navigation when daily usage fails", async () => {
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    const dataSource: DashboardDataSource = {
      overview: async () => overview,
      daily: async () => {
        throw new Error("daily unavailable");
      },
      history: async (provider) => buildPopulatedHistory(provider),
    };
    const { router, queryClient } = createRouterFor(dataSource, "usage");
    rendered(router, queryClient);

    expect(await screen.findByText("Token usage")).toBeTruthy();
    expect((await screen.findAllByText("machine-a")).length).toBeGreaterThan(0);
    expect(
      (
        await screen.findAllByText(
          "Daily usage could not be loaded. Monthly totals remain available.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Dashboard data could not be loaded.")).toBeNull();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
  });

  it("deep-links the usage view and preserves the selected month through navigation", async () => {
    const dataSource: DashboardDataSource = {
      overview: async (input) => buildPopulatedOverview(input.timezone, input.month),
      daily: async (input) => buildPopulatedDaily(input.timezone, input.month),
      history: async (provider) => buildPopulatedHistory(provider),
    };
    const { router, queryClient } = createRouterFor(dataSource, "usage");
    rendered(router, queryClient);

    expect(await screen.findByText("Today · 2026-11-27")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Timezone").value).toBe("UTC");
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(FIXTURE_MONTH);
    const todaySummary = screen.getByLabelText("Today's usage summary");
    expect(within(todaySummary).getByText("11")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });

    expect(await screen.findByText("No token usage for this month")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe("2026-10");
    expect(screen.getByText("Today outside this range")).toBeTruthy();

    router.history.back();

    expect(await screen.findByText("Today · 2026-11-27")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(FIXTURE_MONTH);
  });

  it("redirects legacy usage deep links while retaining tz and month", async () => {
    const dataSource: DashboardDataSource = {
      overview: async (input) => buildPopulatedOverview(input.timezone, input.month),
      daily: async (input) => buildPopulatedDaily(input.timezone, input.month),
      history: async (provider) => buildPopulatedHistory(provider),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const router = createRouter({
      routeTree,
      context: { queryClient, dataSource },
      history: createMemoryHistory({
        initialEntries: [`/?view=usage&tz=UTC&month=${FIXTURE_MONTH}`],
      }),
    });
    rendered(router, queryClient);

    expect(await screen.findByText("Today · 2026-11-27")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({ tz: "UTC", month: FIXTURE_MONTH });
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(FIXTURE_MONTH);
  });

  it("loads each route's own data without starting the other route's queries", async () => {
    let dailyCalls = 0;
    let historyCalls = 0;
    const dataSource: DashboardDataSource = {
      overview: async (input) => buildPopulatedOverview(input.timezone, input.month),
      daily: async (input) => {
        dailyCalls += 1;
        return buildPopulatedDaily(input.timezone, input.month);
      },
      history: async (provider) => {
        historyCalls += 1;
        return buildPopulatedHistory(provider);
      },
    };

    const overviewRouter = createRouterFor(dataSource, "overview");
    rendered(overviewRouter.router, overviewRouter.queryClient);
    expect(await screen.findByText("Balance history (30d)")).toBeTruthy();
    expect(dailyCalls).toBe(0);
    expect(historyCalls).toBeGreaterThan(0);
    cleanup();

    const historyAfterOverview = historyCalls;
    const usageRouter = createRouterFor(dataSource, "usage");
    rendered(usageRouter.router, usageRouter.queryClient);
    expect(await screen.findByText("Token usage")).toBeTruthy();
    expect(dailyCalls).toBeGreaterThan(0);
    expect(historyCalls).toBe(historyAfterOverview);
  });

  it("keeps shared navigation visible when the usage route fails", async () => {
    const dataSource: DashboardDataSource = {
      overview: async () => {
        throw new Error("usage load failed");
      },
      daily: async (input: UsageInput) => buildPopulatedDaily(input.timezone, input.month),
      history: async (provider) => buildPopulatedHistory(provider),
    };
    const { router, queryClient } = createRouterFor(dataSource, "usage");
    rendered(router, queryClient);

    expect(await screen.findByText("Dashboard data could not be loaded.")).toBeTruthy();
    expect(screen.getByText("usage load failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Usage" })).toBeTruthy();
  });

  it("keeps Refresh disabled while balance history loads on the overview", async () => {
    const resolvers: Array<() => void> = [];
    const dataSource: DashboardDataSource = {
      overview: async (input) => buildPopulatedOverview(input.timezone, input.month),
      daily: async (input) => buildPopulatedDaily(input.timezone, input.month),
      history: (provider) =>
        new Promise((resolve) => {
          resolvers.push(() => {
            resolve(buildPopulatedHistory(provider));
          });
        }),
    };
    const { router, queryClient } = createRouterFor(dataSource, "overview");
    rendered(router, queryClient);

    expect(await screen.findByText("Balance history (30d)")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" }).disabled).toBe(
        true,
      );
    });

    for (const resolve of resolvers) {
      resolve();
    }
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" }).disabled).toBe(
        false,
      );
    });
  });

  it("keeps cached overview and histories while surfacing a failed refresh", async () => {
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    let overviewCalls = 0;
    const loadedHistory = new Set<string>();
    const dataSource: DashboardDataSource = {
      overview: async () => {
        overviewCalls += 1;
        if (overviewCalls === 1) {
          return overview;
        }
        throw new Error("overview refresh failed");
      },
      daily: async (input: UsageInput) => buildPopulatedDaily(input.timezone, input.month),
      history: async (provider) => {
        if (!loadedHistory.has(provider)) {
          loadedHistory.add(provider);
          return buildPopulatedHistory(provider);
        }
        throw new Error("history refresh failed");
      },
    };
    const { router, queryClient } = createRouterFor(dataSource, "overview");
    rendered(router, queryClient);

    expect(
      (await screen.findAllByText("OpenCode Go", {}, { timeout: 3000 })).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText("OpenRouter")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Balance history (30d)")).toBeTruthy();

    await queryClient.refetchQueries({ queryKey: ["overview"] }).catch(() => undefined);
    await queryClient.refetchQueries({ queryKey: ["balance-history"] }).catch(() => undefined);

    expect(await screen.findByText("Overview refresh failed. Showing cached data.")).toBeTruthy();
    expect(
      await screen.findByText("Balance history refresh failed. Showing cached history."),
    ).toBeTruthy();
    expect(screen.getAllByText("OpenCode Go").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenRouter").length).toBeGreaterThan(0);
  });

  it("shows empty daily and empty history states without inventing data", async () => {
    const dataSource: DashboardDataSource = {
      overview: async () => ({
        ...buildPopulatedOverview("UTC", FIXTURE_MONTH),
        balances: [],
      }),
      daily: async () => {
        throw new Error("daily unavailable");
      },
      history: async (provider) => buildEmptyHistory(provider),
    };
    const { router, queryClient } = createRouterFor(dataSource, "overview");
    rendered(router, queryClient);

    expect(await screen.findByText("Not configured")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Balance history (30d)")).toBeNull();
    });
  });
});
