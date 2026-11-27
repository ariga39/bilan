import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import {
  balanceHistoryResponseSchema,
  overviewResponseSchema,
  usageDailyResponseSchema,
} from "@bilan/shared/schemas";

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

export const STORYBOOK_SCENARIOS = ["populated", "loading", "empty", "failure"] as const;
export type StorybookScenario = (typeof STORYBOOK_SCENARIOS)[number];

/**
 * Resolve a story parameter against the shared scenario vocabulary. Unknown
 * values throw instead of silently falling back, so a typo is visible in the
 * Storybook error overlay.
 */
export function resolveStorybookScenario(value: unknown): StorybookScenario {
  if (value === undefined) {
    return "populated";
  }
  const scenario = STORYBOOK_SCENARIOS.find((candidate) => candidate === value);
  if (scenario) {
    return scenario;
  }
  throw new Error(
    `Unknown Bilan Storybook scenario ${JSON.stringify(value)}. ` +
      `Expected one of: ${STORYBOOK_SCENARIOS.join(", ")}.`,
  );
}

const realFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input, globalThis.location.href);
    }
    const requestOrUrl = input;
    if ("href" in requestOrUrl) {
      return new URL(requestOrUrl.href);
    }
    return new URL(requestOrUrl.url);
  } catch {
    return null;
  }
}

function isApiRequest(input: RequestInfo | URL): boolean {
  return requestUrl(input)?.pathname.startsWith("/api/v1/") ?? false;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function overviewResponse(url: URL, scenario: StorybookScenario): OverviewResponse {
  const timezone = url.searchParams.get("tz") ?? FIXTURE_TIMEZONE;
  const month = url.searchParams.get("month") ?? FIXTURE_MONTH;
  return scenario === "empty"
    ? buildEmptyOverview(timezone, month)
    : buildPopulatedOverview(timezone, month);
}

function dailyResponse(url: URL, scenario: StorybookScenario): UsageDailyResponse {
  const timezone = url.searchParams.get("tz") ?? FIXTURE_TIMEZONE;
  const month = url.searchParams.get("month") ?? FIXTURE_MONTH;
  return scenario === "empty"
    ? buildEmptyDaily(timezone, month)
    : buildPopulatedDaily(timezone, month);
}

function historyResponse(url: URL, scenario: StorybookScenario): BalanceHistoryResponse {
  const provider: BalanceProvider =
    url.searchParams.get("provider") === "deepseek" ? "deepseek" : "openrouter";
  return scenario === "empty" ? buildEmptyHistory(provider) : buildPopulatedHistory(provider);
}

function mockApiResponse(url: URL, scenario: StorybookScenario): Response {
  switch (url.pathname) {
    case "/api/v1/overview":
      return json(overviewResponseSchema.parse(overviewResponse(url, scenario)));
    case "/api/v1/usage/daily":
      return json(usageDailyResponseSchema.parse(dailyResponse(url, scenario)));
    case "/api/v1/balances/history":
      return json(balanceHistoryResponseSchema.parse(historyResponse(url, scenario)));
    default:
      return new Response("Not found", { status: 404 });
  }
}

/**
 * Replace only the read-API boundary, so stories render the real dashboard
 * components and the app's own fetch/validation logic still runs.
 */
export function installScenarioFetch(scenario: StorybookScenario): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isApiRequest(input)) {
      return realFetch(input, init);
    }

    if (scenario === "loading") {
      return new Promise<Response>(() => {
        // Intentionally pending: keeps the dashboard in its initial loading state.
      });
    }

    if (scenario === "failure") {
      return Promise.reject(
        new Error("The read API is unavailable. Start the local read Worker to use live data."),
      );
    }

    const url = requestUrl(input);
    if (!url) {
      return Promise.reject(new Error("The read API received an invalid request URL."));
    }
    return Promise.resolve(mockApiResponse(url, scenario));
  };
}
