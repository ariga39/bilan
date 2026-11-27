import type { MonthlyUsage, UsageDailyResponse } from "@bilan/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageEntry } from "@/components/usage-entry";
import { UsageSection } from "@/components/usage-section";
import { buildPopulatedOverview } from "@/stories/fixtures";

afterEach(cleanup);

const GENERATED_AT = "2026-11-02T12:00:00Z";

const usage: MonthlyUsage = {
  timezone: "Asia/Shanghai",
  month: "2026-11",
  bucket_attribution: "exact",
  bucket_attribution_note: null,
  latest_bucket_start: "2026-11-02T00:00:00Z",
  data_age_seconds: 120,
  is_stale: false,
  source_freshness: [
    {
      source: "codex",
      latest_bucket_start: "2026-11-02T00:00:00Z",
      data_age_seconds: 120,
      is_stale: false,
    },
    {
      source: "opencode",
      latest_bucket_start: "2026-11-01T18:00:00Z",
      data_age_seconds: 21_600,
      is_stale: true,
    },
  ],
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
    {
      source: "opencode",
      accounting_basis: "orihsus-audit-v1",
      unit_kind: "request",
      actor_kind: "identity",
      actor_id: "laptop-key",
      model: "deepseek-chat",
      effort: "",
      unit_count: 2,
      coverage_gaps: 0,
      input_tokens: 120,
      input_counted: 2,
      cached_tokens: 80,
      cached_counted: 2,
      uncached_tokens: 40,
      uncached_counted: 2,
      cache_write_tokens: null,
      cache_write_counted: 0,
      output_tokens: 10,
      output_counted: 2,
      reasoning_tokens: 4,
      reasoning_counted: 2,
      is_partial: false,
      partial_columns: [],
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
    {
      source: "opencode",
      accounting_basis: "orihsus-audit-v1",
      unit_kind: "request",
      date: "2026-11-02",
      unit_count: 2,
      coverage_gaps: 0,
      input_tokens: 120,
      input_counted: 2,
      cached_tokens: 80,
      cached_counted: 2,
      uncached_tokens: 40,
      uncached_counted: 2,
      cache_write_tokens: null,
      cache_write_counted: 0,
      output_tokens: 10,
      output_counted: 2,
      reasoning_tokens: 4,
      reasoning_counted: 2,
      is_partial: false,
      partial_columns: [],
    },
  ],
};

describe("Token usage dashboard section", () => {
  it("separates platform summaries, today's figures and daily details with partial counters", () => {
    render(
      <UsageSection
        usage={usage}
        daily={daily}
        timezone="Asia/Shanghai"
        month="2026-11"
        generatedAt={GENERATED_AT}
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("Token usage")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Timezone").value).toBe("Asia/Shanghai");
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe("2026-11");
    expect(screen.getByText("Breakdown")).toBeTruthy();

    const codexTable = screen.getByLabelText(
      "Monthly detail for Codex · debitmetre-audit-v1 · request",
    );
    const openCodeTable = screen.getByLabelText(
      "Monthly detail for OpenCode Go · orihsus-audit-v1 · request",
    );
    expect(codexTable).toBeTruthy();
    expect(openCodeTable).toBeTruthy();
    expect(within(codexTable).getByText("machine-a")).toBeTruthy();
    expect(within(codexTable).getByText("machine-b")).toBeTruthy();
    expect(within(codexTable).getByText("gpt-5")).toBeTruthy();
    expect(within(codexTable).getByText("high")).toBeTruthy();
    expect(within(codexTable).getByText("Machine")).toBeTruthy();
    expect(within(openCodeTable).getByText("laptop-key")).toBeTruthy();
    expect(within(openCodeTable).getByText("deepseek-chat")).toBeTruthy();
    expect(within(openCodeTable).getByText("Identity")).toBeTruthy();
    expect(screen.getAllByText("OpenCode Go").length).toBeGreaterThan(0);

    // Freshness is scoped per source, so fresh Codex cannot hide delayed OpenCode Go.
    expect(within(screen.getByLabelText("Codex freshness")).queryByText("Delayed")).toBeNull();
    expect(
      within(screen.getByLabelText("OpenCode Go freshness")).getByText("Delayed"),
    ).toBeTruthy();

    // NULL stays absent (— with Not reported label); explicit zero stays 0; coverage is quiet text.
    expect(within(codexTable).getAllByLabelText("Not reported").length).toBeGreaterThan(0);
    expect(within(codexTable).getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.queryByText("Partial")).toBeNull();
    expect(screen.getAllByText(/metered/u).length).toBeGreaterThan(0);

    expect(screen.getByText("Today · 2026-11-02")).toBeTruthy();
    const todaySummary = screen.getByLabelText("Today's usage summary");
    expect(within(todaySummary).getByText("5")).toBeTruthy();
    expect(within(todaySummary).getByText("4/5")).toBeTruthy();
    expect(screen.getAllByText("This month · November 2026").length).toBeGreaterThan(0);

    expect(screen.getByText("Daily requests")).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Daily requests trend for Codex · debitmetre-audit-v1 · request",
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Daily exact values for Codex · debitmetre-audit-v1 · request"),
    ).toBeTruthy();
    expect(screen.getByText("2026-11-01")).toBeTruthy();
    expect(screen.getAllByText("2026-11-02").length).toBeGreaterThan(0);
  });

  it("formats large token totals compactly by default and switches to exact numbers on toggle", () => {
    const bigUsage: MonthlyUsage = {
      ...usage,
      rows: [
        {
          ...usage.rows[0]!,
          unit_count: 87_467,
          input_tokens: 11_332_976_155,
          input_counted: 86_212,
          output_tokens: 20_763_309,
          output_counted: 86_212,
        },
      ],
    };
    render(
      <UsageSection
        usage={bigUsage}
        daily={daily}
        timezone="Asia/Shanghai"
        month="2026-11"
        generatedAt={GENERATED_AT}
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    const monthSummary = screen.getByLabelText("This month usage summary");
    expect(within(monthSummary).getByText("11.3B")).toBeTruthy();
    expect(within(monthSummary).getByText("20.8M")).toBeTruthy();
    expect(within(monthSummary).getByText("87.5K")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    expect(within(monthSummary).getByText("11,332,976,155")).toBeTruthy();
    expect(within(monthSummary).getByText("20,763,309")).toBeTruthy();
    expect(within(monthSummary).getByText("87,467")).toBeTruthy();
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
        generatedAt={GENERATED_AT}
        onTimezoneChange={onTimezoneChange}
        onMonthChange={onMonthChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
    expect(onTimezoneChange).toHaveBeenCalledWith("UTC");

    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });
    expect(onMonthChange).toHaveBeenCalledWith("2026-10");
  });

  it("labels a historical range distinctly from today", () => {
    render(
      <UsageSection
        usage={{
          ...usage,
          timezone: "UTC",
          month: "2026-10",
          rows: [],
          latest_bucket_start: null,
          data_age_seconds: null,
          source_freshness: [],
        }}
        daily={{ ...daily, timezone: "UTC", month: "2026-10", rows: [] }}
        timezone="UTC"
        month="2026-10"
        generatedAt={GENERATED_AT}
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getAllByText(/Historical month · October 2026/u).length).toBeGreaterThan(0);
    expect(screen.getByText("Today outside this range")).toBeTruthy();
    expect(screen.queryByText(/^Today · /u)).toBeNull();
    expect(screen.getByText("No token usage for this month")).toBeTruthy();
    expect(screen.getByText("No daily usage for this month.")).toBeTruthy();
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
        generatedAt={GENERATED_AT}
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
        usage={{
          ...usage,
          rows: [],
          latest_bucket_start: null,
          data_age_seconds: null,
          source_freshness: [],
        }}
        daily={{ ...daily, timezone: "UTC", rows: [] }}
        timezone="UTC"
        month="2026-11"
        generatedAt={GENERATED_AT}
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("No token usage for this month")).toBeTruthy();
    expect(screen.getByText("No daily usage for this month.")).toBeTruthy();
    expect(screen.queryByText(/^0$/u)).toBeNull();
  });

  it("keeps monthly totals visible when the daily series fails", () => {
    render(
      <UsageSection
        usage={usage}
        daily={null}
        timezone="Asia/Shanghai"
        month="2026-11"
        generatedAt={GENERATED_AT}
        dailyError="Daily usage could not be loaded. Monthly totals remain available."
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getAllByText(/This month · November 2026/u).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Daily usage could not be loaded. Monthly totals remain available.")
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Usage could not be loaded")).toBeNull();
  });

  it("links the overview usage entry to the selected usage route", () => {
    const onOpenUsage = vi.fn();
    render(
      <UsageEntry
        overview={buildPopulatedOverview("UTC", "2026-11")}
        navigation={{ tz: "UTC", month: "2026-11" }}
        onOpenUsage={onOpenUsage}
      />,
    );

    const link = screen.getByRole("link", { name: /Open usage/u });
    expect(link.getAttribute("href")).toBe("/usage?tz=UTC&month=2026-11");
    fireEvent.click(link);
    expect(onOpenUsage).toHaveBeenCalled();
    expect(screen.getByText(/This month · November 2026/u)).toBeTruthy();
    expect(screen.getByText(/Today 2026-11-27/u)).toBeTruthy();
  });
});
