import type { QuotaSubject } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { QuotaOverview } from "@/components/quota-overview";

afterEach(cleanup);

function subject(overrides: Partial<QuotaSubject> = {}): QuotaSubject {
  return {
    source: "agy",
    account: "agy-main",
    latest_valid: {
      sample_id: "agy-valid",
      observer_machine: "studio-a",
      sampled_at: "2026-11-27T11:56:00Z",
      interval_seconds: 300,
      sample_age_seconds: 240,
      is_stale: false,
      status: "ok",
      time_anomaly: null,
      error_summary: null,
      windows: [
        {
          bucket_id: "Gemini",
          slot: "five-hour",
          label: "5h",
          used_percent: 42.5,
          remaining_percent: 57.5,
          status: "ok",
          resets_at: "1970-01-01T00:00:00Z",
          reset_in_seconds: 0,
          window_duration_mins: 300,
        },
      ],
    },
    latest_attempt: {
      sample_id: "agy-valid",
      observer_machine: "studio-a",
      sampled_at: "2026-11-27T11:56:00Z",
      sample_age_seconds: 240,
      status: "ok",
      time_anomaly: null,
      error_summary: null,
    },
    anomalies: [],
    ...overrides,
  };
}

describe("QuotaOverview display", () => {
  it("treats the epoch reset sentinel as missing instead of Jan 1 1970", () => {
    render(<QuotaOverview subjects={[subject()]} />);
    expect(screen.getAllByText(/Reset not reported/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/1970/u)).toBeNull();
  });

  it("rounds the primary percentage while keeping the exact reading in details", () => {
    render(<QuotaOverview subjects={[subject()]} />);
    expect(screen.getByText("58%")).toBeTruthy();
    expect(screen.getAllByText("57.5%").length).toBeGreaterThan(0);
  });
});
