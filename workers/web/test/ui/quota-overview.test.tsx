import type { QuotaSubject } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { QuotaOverview } from "@/components/quota-overview";
import { buildPopulatedOverview, FIXED_NOW, FIXTURE_MONTH } from "@/stories/fixtures";

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

function quota(subjects: Array<QuotaSubject>) {
  return { generated_at: FIXED_NOW, subjects };
}

describe("QuotaOverview display", () => {
  it("treats the epoch reset sentinel as missing instead of Jan 1 1970", () => {
    render(<QuotaOverview quota={quota([subject()])} />);
    expect(screen.getAllByText(/Reset not reported/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/1970/u)).toBeNull();
  });

  it("rounds the primary percentage while keeping the exact reading in details", () => {
    render(<QuotaOverview quota={quota([subject()])} />);
    expect(screen.getByText("58%")).toBeTruthy();
    expect(screen.getAllByText("57.5%").length).toBeGreaterThan(0);
  });

  it("identifies the AGY bucket/model group in the limiting summary", () => {
    render(<QuotaOverview quota={quota([subject()])} />);
    expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
  });

  it("keeps the seven-day visibility boundary and shows collapsed key warnings", () => {
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    render(<QuotaOverview quota={overview.quotas} />);

    expect(screen.getByText("key-fp-2")).toBeTruthy();
    expect(screen.getByText("key-fp-3")).toBeTruthy();
    expect(screen.queryByText("key-fp-4")).toBeNull();
    expect(screen.queryByText("key-fp-5")).toBeNull();
    expect(screen.queryByText("key-fp-7")).toBeNull();

    const summary = screen.getByText("key-fp-3").closest("summary");
    if (!summary) {
      throw new Error("OpenCode summary was not rendered");
    }
    expect(summary.textContent).toContain("Valid sample");
    expect(summary.textContent).toContain("stale");
    expect(summary.textContent).toContain("Latest attempt failed");
  });
});
