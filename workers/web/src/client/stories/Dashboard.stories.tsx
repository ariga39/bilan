import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import { dashboardQuotaSubjects } from "@bilan/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo } from "react";

import { DashboardPending } from "@/components/dashboard-shell";

import {
  buildEmptyDaily,
  buildEmptyHistory,
  buildEmptyOverview,
  buildPopulatedDaily,
  buildPopulatedHistory,
  buildPopulatedOverview,
  FIXTURE_MONTH,
  FIXTURE_TIMEZONE,
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
  return buildScenarioOverview(base, scenario);
}

/** Storybook data sources stand in for the server functions, which own the public projection (anonymous labels + visibility). */
function visibleQuotas(overview: OverviewResponse): OverviewResponse {
  return {
    ...overview,
    quotas: {
      ...overview.quotas,
      subjects: dashboardQuotaSubjects(overview.quotas.subjects, new Date(overview.generated_at)),
    },
  };
}

function dailyFor(input: UsageInput, scenario: StorybookScenario): UsageDailyResponse {
  const daily =
    scenario === "empty"
      ? buildEmptyDaily(input.timezone, input.month)
      : buildPopulatedDaily(input.timezone, input.month);
  return scenario === "usage-sparse"
    ? { ...daily, rows: daily.rows.filter((row) => row.is_partial) }
    : daily;
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
    overview: async (input) => visibleQuotas(overviewFor(input, scenario)),
    daily: async (input) => dailyFor(input, scenario),
    history: async (provider: BalanceProvider) =>
      scenario === "empty" ? buildEmptyHistory(provider) : buildPopulatedHistory(provider),
  };
}

interface StoryArgs {
  scenario: StorybookScenario;
  view?: "overview" | "usage";
  timezone?: string;
  month?: string;
}

function StoryRouter({ scenario, view, timezone, month }: StoryArgs) {
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
          initialEntries: [
            view === "usage"
              ? `/usage?tz=${encodeURIComponent(timezone ?? FIXTURE_TIMEZONE)}&month=${
                  month ?? FIXTURE_MONTH
                }`
              : `/?tz=${encodeURIComponent(timezone ?? FIXTURE_TIMEZONE)}&month=${
                  month ?? FIXTURE_MONTH
                }`,
          ],
        }),
        defaultPreload: "intent",
        defaultPreloadStaleTime: 0,
      }),
    [month, queryClient, scenario, timezone, view],
  );

  if (scenario === "loading") {
    return <DashboardPending label="Loading overview…" />;
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
    view: {
      control: "select",
      options: ["overview", "usage"],
    },
  },
  render: (args: StoryArgs) => (
    <StoryRouter key={`${args.scenario}-${args.view}-${args.timezone}-${args.month}`} {...args} />
  ),
} satisfies Meta<StoryArgs>;

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
export const Usage: Story = {
  name: "Usage (populated)",
  args: { scenario: "populated", view: "usage" },
};
export const UsageMobile: Story = {
  name: "Usage (mobile)",
  args: { scenario: "populated", view: "usage" },
  globals: { viewport: { value: "mobile" } },
};
export const UsageSparse: Story = {
  name: "Usage (sparse partial and unknown coverage)",
  args: { scenario: "usage-sparse", view: "usage" },
};
export const UsageEmptyMonth: Story = {
  name: "Usage (empty historical month)",
  args: { scenario: "populated", view: "usage", month: "2026-10" },
};
export const UsageKolkata: Story = {
  name: "Usage (Asia/Kolkata approximation)",
  args: { scenario: "populated", view: "usage", timezone: "Asia/Kolkata" },
};
