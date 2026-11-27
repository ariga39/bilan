/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- TanStack Start server-function boundary with framework-generated types */
import { dashboardQuotaSubjects, isValidMonth, isValidTimeZone } from "@bilan/shared";
import type { BalanceProvider, OverviewResponse } from "@bilan/shared";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

import { getBalanceHistory, getOverview, getUsageDaily, isBalanceProvider } from "~/worker/queries";
import type { DashboardDataSource, UsageInput } from "./dashboard";

function validateUsageInput(input: UsageInput): UsageInput {
  if (!isValidTimeZone(input.timezone) || !isValidMonth(input.month)) {
    throw new Error("invalid_usage_query");
  }
  return input;
}

const getOverviewData = createServerFn({ method: "GET" })
  .validator(validateUsageInput)
  .handler(async ({ data }): Promise<OverviewResponse> => {
    setResponseHeader("Cache-Control", "private, no-store");
    const now = new Date();
    const overview = await getOverview(env.DB, now, data);
    return {
      ...overview,
      quotas: {
        ...overview.quotas,
        subjects: dashboardQuotaSubjects(overview.quotas.subjects, now),
      },
    };
  });

const getUsageDailyData = createServerFn({ method: "GET" })
  .validator(validateUsageInput)
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    return getUsageDaily(env.DB, data);
  });

const getHistoryData = createServerFn({ method: "GET" })
  .validator((input: { provider: BalanceProvider; days: number }) => {
    if (
      !isBalanceProvider(input.provider) ||
      !Number.isInteger(input.days) ||
      input.days < 1 ||
      input.days > 365
    ) {
      throw new Error("invalid_history_query");
    }
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    return getBalanceHistory(env.DB, data.provider, data.days);
  });

export const dashboardServerSource: DashboardDataSource = {
  overview: (input) => getOverviewData({ data: input }),
  daily: (input) => getUsageDailyData({ data: input }),
  history: (provider, days) => getHistoryData({ data: { provider, days } }),
};
