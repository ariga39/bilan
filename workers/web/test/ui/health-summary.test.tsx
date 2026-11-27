import type { OverviewResponse, QuotaSubject } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HealthSummary } from "@/components/health-summary";
import { buildPopulatedOverview, FIXTURE_MONTH } from "@/stories/fixtures";

afterEach(cleanup);

function quotaSubject(): QuotaSubject {
  return {
    source: "opencode",
    account: "key-old-valid",
    latest_valid: {
      sample_id: "valid",
      observer_machine: "gateway-a",
      sampled_at: "2026-11-27T10:00:00Z",
      interval_seconds: 300,
      sample_age_seconds: 7200,
      is_stale: true,
      status: "ok",
      time_anomaly: null,
      error_summary: null,
      windows: [
        {
          bucket_id: "key-old-valid",
          slot: "rolling",
          label: null,
          used_percent: 10,
          remaining_percent: 90,
          status: "ok",
          resets_at: null,
          reset_in_seconds: null,
          window_duration_mins: 300,
        },
      ],
    },
    latest_attempt: {
      sample_id: "failed",
      observer_machine: "gateway-a",
      sampled_at: "2026-11-27T11:59:00Z",
      sample_age_seconds: 60,
      status: "error",
      time_anomaly: null,
      error_summary: "upstream_error",
    },
    anomalies: [],
  };
}

describe("HealthSummary data freshness", () => {
  it("uses the last successful sample, not a recent failed attempt", () => {
    const base = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    const overview: OverviewResponse = {
      ...base,
      producers: [],
      balances: [],
      usage: {
        ...base.usage,
        latest_bucket_start: null,
        data_age_seconds: null,
        is_stale: false,
        source_freshness: [],
      },
      quotas: { ...base.quotas, subjects: [quotaSubject()] },
    };
    render(<HealthSummary overview={overview} />);
    expect(screen.getByText("Newest data sample 2 h ago")).toBeTruthy();
    expect(screen.queryByText("Newest data sample 1 min ago")).toBeNull();
    expect(screen.getByText("Newest data sample 2 h ago").textContent).not.toContain("1 min ago");
  });
});
