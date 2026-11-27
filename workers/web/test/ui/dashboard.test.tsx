import type { BalanceView } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BalanceCard } from "@/components/balance-card";

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
      actual_interval_seconds: 7 * 86_400 + 9 * 60,
      coverage: "full",
      coverage_reason: null,
      history_complete: true,
    },
    {
      window_days: 30,
      net_delta: -2.5,
      reported_usage_delta: 10.5,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: "2026-10-28T12:00:00Z",
      actual_interval_seconds: 30 * 86_400 + 9 * 60,
      coverage: "full",
      coverage_reason: null,
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
      actual_interval_seconds: 7 * 86_400 + 9 * 60,
      coverage: "full",
      coverage_reason: null,
      history_complete: true,
    },
    {
      window_days: 30,
      net_delta: null,
      reported_usage_delta: null,
      reported_usage_delta_discontinuity: false,
      baseline_sampled_at: null,
      actual_interval_seconds: null,
      coverage: "unavailable",
      coverage_reason: "missing_baseline",
      history_complete: false,
    },
  ],
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

  it("marks a delayed balance sample without treating it as zero", () => {
    render(<BalanceCard balance={{ ...openRouter, is_stale: true, data_age_seconds: 7200 }} />);

    expect(screen.getByText("Delayed")).toBeTruthy();
    expect(screen.getByText(/USD\s37\.50/u)).toBeTruthy();
  });

  it("labels a partial delta window with its actual coverage", () => {
    render(
      <BalanceCard
        balance={{
          ...openRouter,
          deltas: [
            {
              window_days: 7,
              net_delta: -2.5,
              reported_usage_delta: 10.5,
              reported_usage_delta_discontinuity: false,
              baseline_sampled_at: "2026-11-18T12:00:00Z",
              actual_interval_seconds: 9 * 86_400,
              coverage: "partial",
              coverage_reason: "boundary_mismatch",
              history_complete: false,
            },
            {
              window_days: 30,
              net_delta: null,
              reported_usage_delta: null,
              reported_usage_delta_discontinuity: false,
              baseline_sampled_at: null,
              actual_interval_seconds: null,
              coverage: "unavailable",
              coverage_reason: "missing_baseline",
              history_complete: false,
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText("Partial coverage · actual 9 d")).toHaveLength(2);
  });

  it("shows the discontinuity badge when cumulative usage reset inside a positive delta", () => {
    const current7d = openRouter.deltas.find((delta) => delta.window_days === 7);
    if (!current7d) {
      throw new Error("Expected a 7d fixture");
    }

    render(
      <BalanceCard
        balance={{
          ...openRouter,
          deltas: [
            {
              ...current7d,
              reported_usage_delta: 20,
              reported_usage_delta_discontinuity: true,
            },
            ...openRouter.deltas.filter((delta) => delta.window_days === 30),
          ],
        }}
      />,
    );

    expect(screen.getByText("Discontinuity")).toBeTruthy();
    expect(screen.getByText(/\+USD\s20\.00/u)).toBeTruthy();
  });
});
