import type { OverviewResponse, ProducerHealth, QuotaSubject } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HealthSummary } from "@/components/health-summary";
import { buildPopulatedOverview, FIXTURE_MONTH } from "@/stories/fixtures";

afterEach(cleanup);

const NOW = "2026-11-27T12:00:00Z";

const healthyProducer: ProducerHealth = {
  producer_id: "pull-openrouter",
  display_name: "OpenRouter balance",
  mode: "pull",
  expected_interval_seconds: 1800,
  last_heartbeat_at: NOW,
  last_attempt_at: NOW,
  last_status: "ok",
  last_error: null,
  heartbeat_age_seconds: 120,
  is_stale: false,
};

const failedProducer: ProducerHealth = {
  producer_id: "pull-deepseek",
  display_name: "DeepSeek balance",
  mode: "pull",
  expected_interval_seconds: 1800,
  last_heartbeat_at: null,
  last_attempt_at: NOW,
  last_status: "error",
  last_error: "DeepSeek request failed (HTTP 500)",
  heartbeat_age_seconds: null,
  is_stale: true,
};

function overviewWith(producers: Array<ProducerHealth>): OverviewResponse {
  return { ...buildPopulatedOverview("UTC", FIXTURE_MONTH), producers };
}

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

  it("shows a failed collector error without hiding a healthy collector", () => {
    render(<HealthSummary overview={overviewWith([healthyProducer, failedProducer])} />);

    expect(screen.getByText("1 healthy collector")).toBeTruthy();
    expect(screen.getByText(/OpenRouter balance · 2 min ago/u)).toBeTruthy();
    expect(screen.getByText("DeepSeek balance")).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("DeepSeek request failed (HTTP 500)")).toBeTruthy();
  });

  it("marks stale and never-run collectors as needing attention", () => {
    render(
      <HealthSummary
        overview={overviewWith([
          {
            ...healthyProducer,
            producer_id: "pull-stale",
            display_name: "Stale collector",
            heartbeat_age_seconds: 7800,
            is_stale: true,
          },
          {
            ...healthyProducer,
            producer_id: "push-never",
            display_name: "Never collector",
            last_heartbeat_at: null,
            last_attempt_at: null,
            heartbeat_age_seconds: null,
            is_stale: true,
          },
        ])}
      />,
    );

    expect(screen.getByText("0 healthy collectors")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Never run")).toBeTruthy();
  });

  it("shows an explicit empty collector state", () => {
    render(<HealthSummary overview={overviewWith([])} />);

    expect(screen.getByText("0 healthy collectors")).toBeTruthy();
    expect(screen.getByText("No collectors reported yet.")).toBeTruthy();
  });
});
