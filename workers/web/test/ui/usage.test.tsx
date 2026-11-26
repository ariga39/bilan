import type { MonthlyUsage, UsageDailyResponse } from "@bilan/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageSection } from "@/components/usage-section";

afterEach(cleanup);

const usage: MonthlyUsage = {
  timezone: "Asia/Shanghai",
  month: "2026-11",
  bucket_attribution: "exact",
  bucket_attribution_note: null,
  latest_bucket_start: "2026-11-02T00:00:00Z",
  data_age_seconds: 120,
  is_stale: false,
  rows: [
    {
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      actor_kind: "machine",
      actor_id: "machine-a",
      model: "gpt-5",
      effort: "high",
      unit_count: 2,
      coverage_gaps: 0,
      input_tokens: 100,
      input_counted: 2,
      cached_tokens: 40,
      cached_counted: 2,
      uncached_tokens: 60,
      uncached_counted: 2,
      cache_write_tokens: 0,
      cache_write_counted: 2,
      output_tokens: 20,
      output_counted: 2,
      reasoning_tokens: 5,
      reasoning_counted: 2,
      is_partial: false,
      partial_columns: [],
    },
    {
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      actor_kind: "machine",
      actor_id: "machine-b",
      model: "gpt-5-mini",
      effort: "",
      unit_count: 3,
      coverage_gaps: 1,
      input_tokens: null,
      input_counted: 0,
      cached_tokens: null,
      cached_counted: 0,
      uncached_tokens: null,
      uncached_counted: 0,
      cache_write_tokens: null,
      cache_write_counted: 0,
      output_tokens: 30,
      output_counted: 2,
      reasoning_tokens: null,
      reasoning_counted: 0,
      is_partial: true,
      partial_columns: ["input_tokens", "cached_tokens", "uncached_tokens", "reasoning_tokens"],
    },
  ],
};

const daily: UsageDailyResponse = {
  timezone: "Asia/Shanghai",
  month: "2026-11",
  bucket_attribution: "exact",
  bucket_attribution_note: null,
  rows: [
    {
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      date: "2026-11-01",
      unit_count: 1,
      coverage_gaps: 0,
      input_tokens: 10,
      input_counted: 1,
      cached_tokens: 4,
      cached_counted: 1,
      uncached_tokens: 6,
      uncached_counted: 1,
      cache_write_tokens: 0,
      cache_write_counted: 1,
      output_tokens: 5,
      output_counted: 1,
      reasoning_tokens: 1,
      reasoning_counted: 1,
      is_partial: false,
      partial_columns: [],
    },
    {
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      date: "2026-11-02",
      unit_count: 5,
      coverage_gaps: 0,
      input_tokens: 50,
      input_counted: 5,
      cached_tokens: 10,
      cached_counted: 5,
      uncached_tokens: 40,
      uncached_counted: 5,
      cache_write_tokens: 0,
      cache_write_counted: 5,
      output_tokens: 25,
      output_counted: 4,
      reasoning_tokens: 3,
      reasoning_counted: 5,
      is_partial: true,
      partial_columns: ["output_tokens"],
    },
  ],
};

describe("Codex usage dashboard section", () => {
  it("renders timezone/month controls, machine/model/effort rows, daily view, and partial counters", () => {
    render(
      <UsageSection
        usage={usage}
        daily={daily}
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("Codex token usage")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Timezone").value).toBe("Asia/Shanghai");
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe("2026-11");
    expect(screen.getByText("Monthly breakdown")).toBeTruthy();
    expect(screen.getByLabelText("Codex token usage by machine, model, and effort")).toBeTruthy();

    expect(screen.getByText("machine-a")).toBeTruthy();
    expect(screen.getByText("gpt-5")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("machine-b")).toBeTruthy();
    expect(screen.getByText("Unlabelled")).toBeTruthy();

    // NULL stays absent; an explicitly reported zero is shown as 0.
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Partial").length).toBeGreaterThan(0);
    expect(screen.getByText("1 gap")).toBeTruthy();
    expect(screen.getByText("(2/3)")).toBeTruthy();
    expect(screen.getAllByText("Complete").length).toBeGreaterThan(0);

    expect(screen.getByText("Daily view")).toBeTruthy();
    expect(screen.getByLabelText("Daily token usage")).toBeTruthy();
    expect(screen.getByText("2026-11-01")).toBeTruthy();
    expect(screen.getByText("2026-11-02")).toBeTruthy();
    expect(screen.getByText("(4/5)")).toBeTruthy();

    expect(document.body.textContent).not.toMatch(/AGY|quota/iu);
  });

  it("reports timezone and month changes to the dashboard", () => {
    const onTimezoneChange = vi.fn();
    const onMonthChange = vi.fn();

    render(
      <UsageSection
        usage={usage}
        daily={daily}
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={onTimezoneChange}
        onMonthChange={onMonthChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    expect(onTimezoneChange).toHaveBeenCalledWith("UTC");

    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });
    expect(onMonthChange).toHaveBeenCalledWith("2026-10");
  });

  it("discloses approximate hour-bucket boundaries for non-whole-hour offsets", () => {
    const note =
      "Hourly UTC buckets are attributed by bucket_start. Asia/Kolkata has a non-whole-hour UTC offset, so month and day boundaries are approximate.";

    render(
      <UsageSection
        usage={{
          ...usage,
          timezone: "Asia/Kolkata",
          bucket_attribution: "approximate",
          bucket_attribution_note: note,
        }}
        daily={{
          ...daily,
          timezone: "Asia/Kolkata",
          bucket_attribution: "approximate",
          bucket_attribution_note: note,
        }}
        timezone="Asia/Kolkata"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Asia/Kolkata (UTC+5:30)" })).toBeTruthy();
    expect(screen.getByText(/Approximate bucket boundaries/u)).toBeTruthy();
    expect(screen.getByText(/Asia\/Kolkata has a non-whole-hour/u)).toBeTruthy();
  });

  it("shows an explicit empty state without inventing token totals", () => {
    render(
      <UsageSection
        usage={{ ...usage, rows: [], latest_bucket_start: null, data_age_seconds: null }}
        daily={{ ...daily, rows: [] }}
        timezone="UTC"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("No Codex usage for this month")).toBeTruthy();
    expect(screen.getByText("No daily usage for this month.")).toBeTruthy();
    expect(screen.queryByText(/^0$/u)).toBeNull();
  });
});
