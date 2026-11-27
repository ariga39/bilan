import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function createRouterFor(dataSource: DashboardDataSource, view: "overview" | "usage") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient, dataSource },
    history: createMemoryHistory({
      initialEntries: [`/?view=${view}&tz=UTC&month=${FIXTURE_MONTH}`],
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

    expect(await screen.findByText("Token usage breakdown")).toBeTruthy();
    expect((await screen.findAllByText("machine-a")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Daily usage for this selection is unavailable.")).toBeTruthy();
    expect(screen.queryByText("Dashboard data could not be loaded.")).toBeNull();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
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

    expect(await screen.findByText("Quota overview")).toBeTruthy();
    expect((await screen.findAllByText("OpenRouter")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Balance history")).toBeTruthy();

    await queryClient.refetchQueries({ queryKey: ["overview"] }).catch(() => undefined);
    await queryClient.refetchQueries({ queryKey: ["balance-history"] }).catch(() => undefined);

    expect(await screen.findByText("Overview refresh failed. Showing cached data.")).toBeTruthy();
    expect(
      await screen.findByText("Balance history refresh failed. Showing cached history."),
    ).toBeTruthy();
    expect(screen.getByText("Quota overview")).toBeTruthy();
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

    expect(await screen.findByText(/No balance snapshots yet/u)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Balance history")).toBeNull();
    });
  });
});
