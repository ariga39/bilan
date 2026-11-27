import type { OverviewResponse } from "@bilan/shared";

export const STORYBOOK_SCENARIOS = [
  "populated",
  "loading",
  "empty",
  "failure",
  "stale",
  "failed",
  "anomalous",
  "missing-reset",
  "funded-provider",
] as const;
export type StorybookScenario = (typeof STORYBOOK_SCENARIOS)[number];

export function buildScenarioOverview(
  base: OverviewResponse,
  scenario: StorybookScenario,
): OverviewResponse {
  if (scenario === "stale") {
    return {
      ...base,
      quotas: {
        ...base.quotas,
        subjects: base.quotas.subjects.map((subject) =>
          subject.source === "opencode" && subject.account === "key-fp-1" && subject.latest_valid
            ? {
                ...subject,
                latest_valid: {
                  ...subject.latest_valid,
                  is_stale: true,
                  sample_age_seconds: 7200,
                },
              }
            : subject,
        ),
      },
    };
  }
  if (scenario === "failed") {
    return {
      ...base,
      quotas: {
        ...base.quotas,
        subjects: base.quotas.subjects.map((subject) =>
          subject.source === "opencode" && subject.account === "key-fp-1"
            ? {
                ...subject,
                latest_attempt: {
                  sample_id: "key-fp-1-failed",
                  observer_machine: "gateway-a",
                  sampled_at: "2026-11-27T11:59:00Z",
                  sample_age_seconds: 60,
                  status: "error",
                  time_anomaly: null,
                  error_summary: "upstream_error",
                },
              }
            : subject,
        ),
      },
    };
  }
  if (scenario === "anomalous") {
    return {
      ...base,
      quotas: {
        ...base.quotas,
        subjects: base.quotas.subjects.map((subject) =>
          subject.source === "opencode" && subject.account === "key-fp-1"
            ? {
                ...subject,
                anomalies: [
                  {
                    sample_id: "key-fp-1-clock",
                    observer_machine: "gateway-a",
                    sampled_at: "2026-11-27T13:05:00Z",
                    sample_age_seconds: null,
                    status: "ok",
                    time_anomaly: "future_clock_skew",
                    error_summary: null,
                  },
                ],
              }
            : subject,
        ),
      },
    };
  }
  if (scenario === "missing-reset") {
    return {
      ...base,
      quotas: {
        ...base.quotas,
        subjects: base.quotas.subjects.map((subject) =>
          subject.latest_valid
            ? {
                ...subject,
                latest_valid: {
                  ...subject.latest_valid,
                  windows: subject.latest_valid.windows.map((window) => ({
                    ...window,
                    resets_at: null,
                    reset_in_seconds: null,
                  })),
                },
              }
            : subject,
        ),
      },
    };
  }
  if (scenario === "funded-provider") {
    return {
      ...base,
      balances: base.balances.map((balance) =>
        balance.provider === "openrouter"
          ? {
              ...balance,
              total_balance: 487.25,
              credit_limit: 500,
              cumulative_usage: 512.75,
            }
          : balance,
      ),
    };
  }
  return base;
}
