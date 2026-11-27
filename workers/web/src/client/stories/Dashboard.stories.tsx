import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import { filterVisibleQuotaSubjects } from "@bilan/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo } from "react";

import { DashboardLoading } from "@/Dashboard";

import {
  buildEmptyDaily,
  buildEmptyHistory,
  buildEmptyOverview,
  buildPopulatedDaily,
  buildPopulatedHistory,
  buildPopulatedOverview,
  FIXTURE_MONTH,
} from "./fixtures";
import type { StorybookScenario } from "./scenarios";
import { STORYBOOK_SCENARIOS, buildScenarioOverview } from "./scenarios";
import type { DashboardDataSource, UsageInput } from "../../query/dashboard";
import { routeTree } from "../../routeTree.gen";

function overviewFor(input: UsageInput, scenario: StorybookScenario): OverviewResponse {
  const base =
    scenario === "empty"
      ? buildEmptyOverview(input.timezone, input.month)
      : buildPopulatedOverview(input.timezone, input.month);
  const overview = buildScenarioOverview(base, scenario);
  return {
    ...overview,
    quotas: {
      ...overview.quotas,
      subjects: filterVisibleQuotaSubjects(
        overview.quotas.subjects,
        new Date(overview.generated_at),
      ),
    },
  };
}

function dailyFor(input: UsageInput, scenario: StorybookScenario): UsageDailyResponse {
  return scenario === "empty"
    ? buildEmptyDaily(input.timezone, input.month)
    : buildPopulatedDaily(input.timezone, input.month);
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally pending for the loading story.
  });
}

function failure(): Promise<never> {
  return Promise.reject(new Error("The read API is unavailable."));
}

function createDataSource(scenario: StorybookScenario): DashboardDataSource {
  if (scenario === "loading") {
    return {
      overview: pending<OverviewResponse>,
      daily: pending<UsageDailyResponse>,
      history: pending<BalanceHistoryResponse>,
    };
  }
  if (scenario === "failure") {
    return {
      overview: failure,
      daily: failure,
      history: failure,
    };
  }
  return {
    overview: async (input) => overviewFor(input, scenario),
    daily: async (input) => dailyFor(input, scenario),
    history: async (provider: BalanceProvider) =>
      scenario === "empty" ? buildEmptyHistory(provider) : buildPopulatedHistory(provider),
  };
}

function StoryRouter({ scenario }: { scenario: StorybookScenario }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 60_000 },
        },
      }),
    [],
  );
  const router = useMemo(
    () =>
      createRouter({
        routeTree,
        context: { queryClient, dataSource: createDataSource(scenario) },
        history: createMemoryHistory({
          initialEntries: [`/?view=overview&tz=UTC&month=${FIXTURE_MONTH}`],
        }),
        defaultPreload: "intent",
        defaultPreloadStaleTime: 0,
      }),
    [queryClient, scenario],
  );

  if (scenario === "loading") {
    return <DashboardLoading />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Dashboard",
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    scenario: {
      control: "select",
      options: STORYBOOK_SCENARIOS,
    },
  },
  render: (args: { scenario: StorybookScenario }) => (
    <StoryRouter key={args.scenario} scenario={args.scenario} />
  ),
} satisfies Meta<{ scenario: StorybookScenario }>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = { args: { scenario: "populated" } };
export const PopulatedMobile: Story = {
  name: "Populated (mobile)",
  args: { scenario: "populated" },
  globals: { viewport: { value: "mobile" } },
};
export const Loading: Story = { args: { scenario: "loading" } };
export const Empty: Story = { args: { scenario: "empty" } };
export const Failure: Story = { args: { scenario: "failure" } };
export const Stale: Story = { args: { scenario: "stale" } };
export const Failed: Story = { args: { scenario: "failed" } };
export const Anomalous: Story = { args: { scenario: "anomalous" } };
export const MissingReset: Story = {
  name: "Missing reset",
  args: { scenario: "missing-reset" },
};
export const FundedProvider: Story = {
  name: "Funded provider",
  args: { scenario: "funded-provider" },
};
