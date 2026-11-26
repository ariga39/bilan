import type { BalanceView, ProducerHealth } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BalanceCard } from "@/components/balance-card";
import { HealthStrip } from "@/components/health-strip";

afterEach(cleanup);

const NOW = "2026-11-27T12:00:00Z";

const openRouter: BalanceView = {
  producer_id: "pull-openrouter",
  provider: "openrouter",
  account: "default",
  currency: "USD",
  sampled_at: NOW,
  ingested_at: NOW,
  total_balance: 37.5,
  topped_up_balance: null,
  granted_balance: null,
  cumulative_usage: 12.5,
  credit_limit: 50,
  is_available: null,
  data_age_seconds: 120,
  is_stale: false,
  deltas: [
    {
      window_days: 7,
      net_delta: 7.5,
      reported_usage_delta: 7.5,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: "2026-11-20T12:00:00Z",
      history_complete: true,
    },
    {
      window_days: 30,
      net_delta: -2.5,
      reported_usage_delta: 10.5,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: "2026-10-28T12:00:00Z",
      history_complete: true,
    },
  ],
};

const deepSeek: BalanceView = {
  producer_id: "pull-deepseek",
  provider: "deepseek",
  account: "default",
  currency: "CNY",
  sampled_at: NOW,
  ingested_at: NOW,
  total_balance: 83.5,
  topped_up_balance: 80,
  granted_balance: 3.5,
  cumulative_usage: null,
  credit_limit: null,
  is_available: true,
  data_age_seconds: 120,
  is_stale: false,
  deltas: [
    {
      window_days: 7,
      net_delta: -16.5,
      reported_usage_delta: null,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: "2026-11-20T12:00:00Z",
      history_complete: true,
    },
    {
      window_days: 30,
      net_delta: null,
      reported_usage_delta: null,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: null,
      history_complete: false,
    },
  ],
};

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

describe("balance presentation", () => {
  it("labels balance and reported-usage changes per currency and marks partial history", () => {
    render(
      <div>
        <BalanceCard balance={openRouter} />
        <BalanceCard balance={deepSeek} />
      </div>,
    );

    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getAllByText("USD").length).toBeGreaterThan(0);
    expect(screen.getAllByText("CNY").length).toBeGreaterThan(0);
    expect(screen.getByText("Reported usage delta (7d)")).toBeTruthy();
    expect(screen.getAllByText("Net balance change (7d)")).toHaveLength(2);
    expect(screen.getAllByText("Incomplete history")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/spend|burn/iu);
  });

  it("shows a failed collector error without hiding a healthy collector", () => {
    render(<HealthStrip producers={[healthyProducer, failedProducer]} />);

    expect(screen.getByText("OpenRouter balance")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("DeepSeek balance")).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("DeepSeek request failed (HTTP 500)")).toBeTruthy();
  });

  it("marks a delayed balance sample without treating it as zero", () => {
    render(<BalanceCard balance={{ ...openRouter, is_stale: true, data_age_seconds: 7200 }} />);

    expect(screen.getByText("Delayed")).toBeTruthy();
    expect(screen.getByText(/USD\s37\.50/u)).toBeTruthy();
  });
});
