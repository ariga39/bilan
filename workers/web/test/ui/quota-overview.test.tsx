import type { QuotaSubject } from "@bilan/shared";
import { dashboardQuotaSubjects } from "@bilan/shared";
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
      account: "Go#12",
      latest_valid: {
        ...base.latest_valid,
        windows: [
          {
            ...base.latest_valid.windows[0]!,
            bucket_id: "Go#12",
            slot: "rolling",
            label: null,
            used_percent: null,
            remaining_percent: null,
            status: "limited",
          },
          {
            ...base.latest_valid.windows[0]!,
            bucket_id: "Go#12",
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
    expect(screen.getByText("Go#12")).toBeTruthy();
    expect(screen.getByText("Limited")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("renders server-visible subjects with stale, reset, limited, and anomaly warnings", () => {
    const overview = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    const visibleQuota = {
      ...overview.quotas,
      subjects: dashboardQuotaSubjects(overview.quotas.subjects, new Date(FIXED_NOW)),
    };
    render(<QuotaOverview quota={visibleQuota} />);

    expect(screen.getByText("Go#1")).toBeTruthy();
    expect(screen.getByText("Go#2")).toBeTruthy();
    expect(screen.getByText("Go#3")).toBeTruthy();
    expect(screen.queryByText("Go#4")).toBeNull();
    expect(screen.queryByText("key-fp-1")).toBeNull();
    expect(JSON.stringify(visibleQuota)).not.toMatch(/key-fp-/u);

    // Only the latest valid sample's windows are visible with exact values,
    // countdowns, and sample ages.
    expect(screen.getByTitle(/57\.5% remaining · 42\.5% used/u)).toBeTruthy();
    expect(screen.getByText("in 15 min")).toBeTruthy();
    expect(screen.getByText(/5 min ago/u)).toBeTruthy();
    expect(screen.getAllByText("Reset passed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getByText("Limited")).toBeTruthy();
    expect(screen.getByText(/upstream_error/u)).toBeTruthy();

    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.getByText(/Clock anomaly/u)).toBeTruthy();
    expect(screen.getByText(/future_clock_skew/u)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("numbers legacy OpenCode keys before hiding stale ones", () => {
    const base = subject();
    const stale = subject({
      source: "opencode",
      account: "key-fp-old",
      latest_valid: {
        ...base.latest_valid!,
        sampled_at: "2026-11-10T12:00:00Z",
        sample_age_seconds: 1_468_800,
        is_stale: true,
      },
      latest_attempt: {
        ...base.latest_attempt!,
        sampled_at: "2026-11-10T12:00:00Z",
        sample_age_seconds: 1_468_800,
      },
    });
    const fresh = subject({ source: "opencode", account: "key-fp-new" });

    const visible = dashboardQuotaSubjects([stale, fresh], new Date(FIXED_NOW));

    render(<QuotaOverview quota={quota(visible)} />);
    expect(screen.getByText("Go#2")).toBeTruthy();
    expect(screen.queryByText("Go#1")).toBeNull();
    expect(JSON.stringify(visible)).not.toMatch(/key-fp-/u);
  });

  it("keeps the last valid windows while warning about empty and failed attempts", () => {
    const base = subject({ source: "opencode", account: "key-fp-a" });
    if (!base.latest_valid) {
      throw new Error("fixture must have a valid observation");
    }
    const emptyAttempt = subject({
      source: "opencode",
      account: "key-fp-a",
      latest_valid: {
        ...base.latest_valid,
        windows: [
          {
            ...base.latest_valid.windows[0]!,
            bucket_id: "key-fp-a",
            slot: "rolling",
            label: null,
            used_percent: 0,
            remaining_percent: 100,
            status: "ok",
            resets_at: null,
            reset_in_seconds: null,
          },
        ],
      },
      latest_attempt: {
        sample_id: "empty-attempt",
        observer_machine: "gateway-a",
        sampled_at: "2026-11-27T11:59:00Z",
        sample_age_seconds: 60,
        status: "empty",
        time_anomaly: null,
        error_summary: null,
      },
    });
    const failedOnly = subject({
      source: "opencode",
      account: "key-fp-b",
      latest_valid: null,
      latest_attempt: {
        sample_id: "opencode:key-fp-b:2026-11-27T11:57:00Z:abc",
        observer_machine: "gateway-a",
        sampled_at: "2026-11-27T11:57:00Z",
        sample_age_seconds: 180,
        status: "error",
        time_anomaly: null,
        error_summary: "upstream_error for key-fp-b",
      },
      anomalies: [
        {
          sample_id: "opencode:key-fp-b:2099-01-01T00:00:00Z:def",
          observer_machine: "gateway-a",
          sampled_at: "2099-01-01T00:00:00Z",
          sample_age_seconds: null,
          status: "error",
          time_anomaly: "future_clock_skew",
          error_summary: "key-fp-b clock rejected",
        },
      ],
    });

    const visible = dashboardQuotaSubjects([emptyAttempt, failedOnly], new Date(FIXED_NOW));
    render(<QuotaOverview quota={quota(visible)} />);

    expect(screen.getByText("Go#1")).toBeTruthy();
    expect(screen.getByText("Go#2")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText(/Latest attempt was empty/u)).toBeTruthy();
    expect(screen.getByText(/Latest attempt failed/u)).toBeTruthy();
    expect(screen.getByText(/upstream_error for Go#2/u)).toBeTruthy();
    expect(screen.getByText("No valid quota windows.")).toBeTruthy();
    expect(screen.queryByText(/key-fp-/u)).toBeNull();
    expect(JSON.stringify(visible)).not.toMatch(/key-fp-/u);
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("shows explicit empty states without inventing quota readings", () => {
    render(<QuotaOverview quota={quota([])} />);

    expect(screen.getByText("No ChatGPT Subs quota observations yet.")).toBeTruthy();
    expect(screen.getByText("No Google AI Subs quota observations yet.")).toBeTruthy();
    expect(screen.getByText("No active OpenCode Go keys in the last 7 days.")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("Not reported")).toBeNull();
  });
});
