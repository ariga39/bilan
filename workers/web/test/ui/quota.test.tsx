import type { QuotaAttempt, QuotaObservation, QuotaResponse, QuotaWindow } from "@bilan/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { QuotaSection } from "@/components/quota-section";

afterEach(cleanup);

function windowView({ slot, ...overrides }: Partial<QuotaWindow> & { slot: string }): QuotaWindow {
  return {
    bucket_id: "fp_a",
    slot,
    label: null,
    used_percent: null,
    remaining_percent: null,
    status: "ok",
    resets_at: null,
    reset_in_seconds: null,
    window_duration_mins: null,
    ...overrides,
  };
}

function observation({
  sample_id,
  sampled_at,
  ...overrides
}: Partial<QuotaObservation> & { sample_id: string; sampled_at: string }): QuotaObservation {
  return {
    sample_id,
    observer_machine: "gateway-a",
    sampled_at,
    interval_seconds: 300,
    sample_age_seconds: 300,
    is_stale: false,
    status: "ok",
    time_anomaly: null,
    error_summary: null,
    windows: [],
    ...overrides,
  };
}

function attempt({
  sample_id,
  sampled_at,
  ...overrides
}: Partial<QuotaAttempt> & { sample_id: string; sampled_at: string }): QuotaAttempt {
  return {
    sample_id,
    observer_machine: "gateway-a",
    sampled_at,
    sample_age_seconds: 120,
    status: "ok",
    time_anomaly: null,
    error_summary: null,
    ...overrides,
  };
}

const quota: QuotaResponse = {
  generated_at: "2026-11-27T12:00:00Z",
  subjects: [
    {
      source: "opencode",
      account: "fp_a",
      latest_valid: observation({
        sample_id: "fp_a-valid",
        sampled_at: "2026-11-27T11:55:00Z",
        sample_age_seconds: 300,
        windows: [
          windowView({
            slot: "rolling",
            label: "go-key-1",
            used_percent: 42.5,
            remaining_percent: 57.5,
            resets_at: "2026-11-27T12:15:00Z",
            reset_in_seconds: 900,
          }),
          windowView({
            slot: "weekly",
            used_percent: 10,
            remaining_percent: 90,
            resets_at: "2026-11-27T12:05:00Z",
            reset_in_seconds: 300,
          }),
        ],
      }),
      latest_attempt: attempt({
        sample_id: "fp_a-error",
        sampled_at: "2026-11-27T11:58:00Z",
        status: "error",
        error_summary: "upstream HTTP 500",
      }),
      anomalies: [
        attempt({
          sample_id: "fp_a-anomaly",
          sampled_at: "2026-11-27T11:59:00Z",
          sample_age_seconds: 60,
          time_anomaly: "clock_skew",
        }),
      ],
    },
    {
      source: "opencode",
      account: "fp_stale",
      latest_valid: observation({
        sample_id: "fp_stale-valid",
        sampled_at: "2026-11-27T10:00:00Z",
        sample_age_seconds: 7200,
        is_stale: true,
        windows: [
          windowView({
            bucket_id: "fp_stale",
            slot: "rolling",
            used_percent: 95,
            remaining_percent: 5,
            resets_at: "2026-11-27T09:00:00Z",
            reset_in_seconds: 0,
          }),
        ],
      }),
      latest_attempt: attempt({
        sample_id: "fp_stale-valid",
        sampled_at: "2026-11-27T10:00:00Z",
        sample_age_seconds: 7200,
      }),
      anomalies: [],
    },
    {
      source: "opencode",
      account: "fp_empty",
      latest_valid: observation({
        sample_id: "fp_empty-valid",
        sampled_at: "2026-11-27T11:50:00Z",
        sample_age_seconds: 600,
      }),
      latest_attempt: attempt({
        sample_id: "fp_empty-empty",
        sampled_at: "2026-11-27T11:56:00Z",
        sample_age_seconds: 240,
        status: "empty",
      }),
      anomalies: [],
    },
    {
      source: "opencode",
      account: "fp_error_only",
      latest_valid: null,
      latest_attempt: attempt({
        sample_id: "fp_error_only-error",
        sampled_at: "2026-11-27T11:57:00Z",
        sample_age_seconds: 180,
        status: "error",
        error_summary: "upstream HTTP 503",
      }),
      anomalies: [],
    },
    {
      source: "codex",
      account: "codex-main",
      latest_valid: observation({
        sample_id: "codex-valid",
        sampled_at: "2026-11-27T11:58:00Z",
        sample_age_seconds: 120,
        observer_machine: "machine-a",
        windows: [
          windowView({
            bucket_id: "codex-limit",
            slot: "5h",
            used_percent: 80,
            remaining_percent: 20,
            status: "limited",
            resets_at: "2026-11-27T12:10:00Z",
            reset_in_seconds: 600,
          }),
        ],
      }),
      latest_attempt: attempt({
        sample_id: "codex-valid",
        sampled_at: "2026-11-27T11:58:00Z",
        sample_age_seconds: 120,
        observer_machine: "machine-a",
      }),
      anomalies: [],
    },
    {
      source: "agy",
      account: "agy-main",
      latest_valid: observation({
        sample_id: "agy-valid",
        sampled_at: "2026-11-27T11:56:00Z",
        sample_age_seconds: 240,
        observer_machine: "studio-a",
        windows: [
          windowView({
            bucket_id: "Gemini",
            slot: "five-hour",
            label: "5h",
            used_percent: 40,
            remaining_percent: 60,
            resets_at: "2026-11-27T16:00:00Z",
            reset_in_seconds: 14_400,
            window_duration_mins: 300,
          }),
          windowView({
            bucket_id: "Gemini",
            slot: "weekly",
            label: "7d",
            used_percent: 20,
            remaining_percent: 80,
            resets_at: "2026-12-03T00:00:00Z",
            reset_in_seconds: 432_000,
            window_duration_mins: 10_080,
          }),
        ],
      }),
      latest_attempt: attempt({
        sample_id: "agy-valid",
        sampled_at: "2026-11-27T11:56:00Z",
        sample_age_seconds: 240,
        observer_machine: "studio-a",
      }),
      anomalies: [
        attempt({
          sample_id: "agy-future",
          sampled_at: "2099-01-01T00:00:00Z",
          sample_age_seconds: 0,
          time_anomaly: "future_clock_skew",
        }),
      ],
    },
  ],
};

describe("B3/B4 quota dashboard section", () => {
  it("renders latest valid windows per key with age, countdown, and separate warnings", () => {
    render(<QuotaSection quota={quota} />);

    expect(screen.getByText("Quota windows")).toBeTruthy();
    expect(screen.getAllByText("OpenCode Go").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AGY").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Key").length).toBeGreaterThan(0);
    expect(screen.getByText("fp_a")).toBeTruthy();
    expect(screen.getByText("codex-main")).toBeTruthy();
    expect(screen.getByText("agy-main")).toBeTruthy();
    expect(screen.queryByText("Machine")).toBeNull();
    expect(screen.getByText(/AGY tokens are not collected/u)).toBeTruthy();

    expect(screen.getByLabelText("Quota windows for OpenCode Go fp_a")).toBeTruthy();
    expect(screen.getByLabelText("Quota windows for Codex codex-main")).toBeTruthy();
    expect(screen.getByLabelText("Quota windows for AGY agy-main")).toBeTruthy();
    expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
    expect(screen.getByText("five-hour")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.getByText("future_clock_skew")).toBeTruthy();

    // Only the latest valid sample's windows are visible; no older monthly ghost.
    expect(screen.getAllByText("rolling").length).toBeGreaterThan(0);
    expect(screen.getByText("go-key-1")).toBeTruthy();
    expect(screen.getAllByText("weekly").length).toBeGreaterThan(0);
    expect(screen.queryByText("monthly")).toBeNull();
    expect(screen.getByText("42.5%")).toBeTruthy();
    expect(screen.getByText("57.5%")).toBeTruthy();
    expect(screen.getByText("in 15 min")).toBeTruthy();
    expect(screen.getByText(/5 min ago/u)).toBeTruthy();

    expect(screen.getByText("Stale sample")).toBeTruthy();
    expect(screen.getByText("Reset time passed")).toBeTruthy();
    expect(screen.getAllByText("5h").length).toBeGreaterThan(0);
    expect(screen.getByText("Limited")).toBeTruthy();

    expect(screen.getAllByText("Latest attempt failed").length).toBeGreaterThan(0);
    expect(screen.getByText("upstream HTTP 500")).toBeTruthy();
    expect(screen.getByText("upstream HTTP 503")).toBeTruthy();
    expect(screen.getByText("Latest attempt was empty")).toBeTruthy();
    expect(screen.getAllByText("Clock anomaly detected").length).toBeGreaterThan(0);
    expect(screen.getByText("clock_skew")).toBeTruthy();
    expect(screen.getByText(/No valid quota sample yet/u)).toBeTruthy();
    expect(screen.getByText(/No windows in the latest valid sample/u)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("shows an explicit empty state without inventing quota readings", () => {
    render(
      <QuotaSection
        quota={{
          generated_at: "2026-11-27T12:00:00Z",
          subjects: [],
        }}
      />,
    );

    expect(screen.getByText("No quota observations yet")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("Not reported")).toBeNull();
  });
});
