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
        {
          bucket_id: "Gemini",
          slot: "weekly",
          label: "weekly",
          used_percent: 20,
          remaining_percent: 80,
          status: null,
          resets_at: "2026-12-03T10:32:00Z",
          reset_in_seconds: 548_400,
          window_duration_mins: 10_080,
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
    expect(screen.queryByText(/1970/u)).toBeNull();
  });

  it("shows 5h and weekly windows directly with progress bars and omits null status badges", () => {
    render(<QuotaOverview quota={quota([subject()])} />);
    expect(screen.getByText("Google AI Subs")).toBeTruthy();
    expect(screen.getByText("ChatGPT Subs")).toBeTruthy();
    expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("weekly")).toBeTruthy();
    expect(screen.getByText("58%")).toBeTruthy();
    expect(screen.getAllByText("80%").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.queryByText("Not reported")).toBeNull();
  });

  it("collapses Claude and GPT models buckets into a secondary disclosure while preserving all windows and statuses", () => {
    const base = subject();
    if (!base.latest_valid) {
      throw new Error("fixture must have a valid observation");
    }
    const mixed = subject({
      latest_valid: {
        ...base.latest_valid,
        windows: [
          ...base.latest_valid.windows,
          {
            bucket_id: "Gemini",
            slot: "monthly",
            label: "monthly",
            used_percent: 10,
            remaining_percent: 90,
            status: "unknown",
            resets_at: null,
            reset_in_seconds: null,
            window_duration_mins: 43_200,
          },
          {
            bucket_id: "Claude and GPT models",
            slot: "five-hour",
            label: "5h",
            used_percent: 0,
            remaining_percent: 100,
            status: "ok",
            resets_at: null,
            reset_in_seconds: null,
            window_duration_mins: 300,
          },
        ],
      },
    });
    render(<QuotaOverview quota={quota([mixed])} />);
    expect(screen.getByText("Other models (1)")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("groups multiple ChatGPT Subs accounts with individual stale indicators", () => {
    const base = subject({ source: "codex", account: "codex-a" });
    if (!base.latest_valid) {
      throw new Error("fixture must have a valid observation");
    }
    const staleSecond = subject({
      source: "codex",
      account: "codex-b",
      latest_valid: {
        ...base.latest_valid,
        is_stale: true,
        sample_age_seconds: 3600,
      },
    });
    render(<QuotaOverview quota={quota([base, staleSecond])} />);
    expect(screen.getByText("codex-a")).toBeTruthy();
    expect(screen.getByText("codex-b")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("shows limited status and missing percentage without inventing zero", () => {
    const base = subject();
    if (!base.latest_valid) {
      throw new Error("fixture must have a valid observation");
    }
    const limited = subject({
      source: "opencode",
      account: "key-limited",
      latest_valid: {
        ...base.latest_valid,
        windows: [
          {
            ...base.latest_valid.windows[0]!,
            bucket_id: "key-limited",
            slot: "rolling",
            label: null,
            used_percent: null,
            remaining_percent: null,
            status: "limited",
          },
          {
            ...base.latest_valid.windows[0]!,
            bucket_id: "key-limited",
            slot: "weekly",
            label: null,
            used_percent: 20,
            remaining_percent: 80,
            status: "ok",
          },
        ],
      },
    });
    render(<QuotaOverview quota={quota([limited])} />);
    expect(screen.getByText("key-limited")).toBeTruthy();
    expect(screen.getByText("Limited")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("keeps the seven-day visibility boundary and surfaces stale and failure warnings", () => {
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    render(<QuotaOverview quota={overview.quotas} />);

    expect(screen.getByText("key-fp-2")).toBeTruthy();
    expect(screen.getByText("key-fp-3")).toBeTruthy();
    expect(screen.queryByText("key-fp-4")).toBeNull();
    expect(screen.queryByText("key-fp-5")).toBeNull();
    expect(screen.queryByText("key-fp-7")).toBeNull();

    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getByText(/Latest attempt failed/u)).toBeTruthy();
  });
});
