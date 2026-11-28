import type { MonthlyUsage, UsageRangeResponse } from "@bilan/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageEntry } from "@/components/usage-entry";
import { UsageSection } from "@/components/usage-section";
import { buildPopulatedOverview, buildPopulatedRange } from "@/stories/fixtures";

afterEach(cleanup);

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

describe("Token usage dashboard section", () => {
  it("separates platform monthly breakdowns with partial counters and without Today or Daily charts", () => {
    render(
      <UsageSection
        usage={usage}
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("Token usage")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Timezone").value).toBe("Asia/Shanghai");
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe("2026-11");
    expect(screen.getByText("Monthly breakdown · November 2026")).toBeTruthy();

    // Today and duplicate Daily requests charts are intentionally absent from /usage.
    expect(screen.queryByText(/^Today · /u)).toBeNull();
    expect(screen.queryByText("Daily requests")).toBeNull();

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
  });

  it("uses coverage gaps for Go's overall caption while optional columns keep their coverage", () => {
    const optionalUsage: MonthlyUsage = {
      timezone: "Asia/Shanghai",
      month: "2026-11",
      bucket_attribution: "exact",
      bucket_attribution_note: null,
      latest_bucket_start: "2026-11-02T00:00:00Z",
      data_age_seconds: 120,
      is_stale: false,
      source_freshness: [
        {
          source: "opencode",
          latest_bucket_start: "2026-11-02T00:00:00Z",
          data_age_seconds: 120,
          is_stale: false,
        },
      ],
      rows: [
        {
          source: "opencode",
          accounting_basis: "orihsus-audit-v1",
          unit_kind: "request",
          actor_kind: "identity",
          actor_id: "laptop-key",
          model: "deepseek-chat",
          effort: "",
          unit_count: 3,
          coverage_gaps: 1,
          input_tokens: 300,
          input_counted: 3,
          cached_tokens: 100,
          cached_counted: 3,
          uncached_tokens: 200,
          uncached_counted: 3,
          cache_write_tokens: null,
          cache_write_counted: 0,
          output_tokens: 30,
          output_counted: 3,
          reasoning_tokens: 10,
          reasoning_counted: 1,
          is_partial: true,
          partial_columns: ["reasoning_tokens"],
        },
      ],
    };

    render(
      <UsageSection
        usage={optionalUsage}
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    // Gaps cover the required counters: 2 of 3 inference requests are metered.
    expect(screen.getAllByText("66.7% metered · 1 gap").length).toBeGreaterThan(0);
    // The optional reasoning column still reports its own 1-of-3 coverage.
    expect(screen.getAllByText("1/3").length).toBeGreaterThan(0);
  });

  it("formats large token totals compactly by default and switches to exact numbers across rolling and monthly", () => {
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
    const rolling = buildPopulatedRange("Asia/Shanghai", "24h");
    render(
      <UsageSection
        usage={bigUsage}
        range={rolling}
        rangeWindow="24h"
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={() => undefined}
      />,
    );

    const breakdownSummary = screen.getByRole("group", { name: "Monthly breakdown summary" });
    expect(within(breakdownSummary).getAllByText("11.3B").length).toBeGreaterThan(0);
    expect(within(breakdownSummary).getAllByText("20.8M").length).toBeGreaterThan(0);
    expect(within(breakdownSummary).getAllByText("87.5K").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Exact" }));
    expect(within(breakdownSummary).getAllByText("11,332,976,155").length).toBeGreaterThan(0);
    expect(within(breakdownSummary).getAllByText("20,763,309").length).toBeGreaterThan(0);
    expect(within(breakdownSummary).getAllByText("87,467").length).toBeGreaterThan(0);
  });

  it("reports timezone and month changes to the dashboard", () => {
    const onTimezoneChange = vi.fn();
    const onMonthChange = vi.fn();

    render(
      <UsageSection
        usage={usage}
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

  it("shows an explicit empty state for a historical month without inventing token totals", () => {
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
        timezone="UTC"
        month="2026-10"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(screen.getByText("Monthly breakdown · October 2026")).toBeTruthy();
    expect(screen.getByText("No token usage for this month")).toBeTruthy();
    expect(screen.queryByText(/^0$/u)).toBeNull();
  });

  it("discloses approximate hour-bucket boundaries once at the top for non-whole-hour offsets", () => {
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
        range={{
          ...buildPopulatedRange("Asia/Kolkata", "24h"),
          bucket_attribution: "approximate",
          bucket_attribution_note: note,
        }}
        rangeWindow="24h"
        timezone="Asia/Kolkata"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Asia/Kolkata (UTC+5:30)" })).toBeTruthy();
    expect(screen.getByText(/Approximate bucket boundaries/u)).toBeTruthy();
    expect(screen.getByText(/Asia\/Kolkata has a non-whole-hour/u)).toBeTruthy();
  });

  it("keeps monthly breakdown visible when rolling usage fails", () => {
    render(
      <UsageSection
        usage={usage}
        range={null}
        rangeWindow="24h"
        timezone="Asia/Shanghai"
        month="2026-11"
        rangeError="Rolling usage could not be loaded. Monthly breakdown remains available."
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={() => undefined}
      />,
    );

    expect(screen.getByText("Monthly breakdown · November 2026")).toBeTruthy();
    expect(
      screen.getByText("Rolling usage could not be loaded. Monthly breakdown remains available."),
    ).toBeTruthy();
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

  it("shows rolling requests, token and cache trends alongside monthly breakdown", () => {
    const onWindowChange = vi.fn();
    const rolling = buildPopulatedRange("Asia/Shanghai", "24h");

    render(
      <UsageSection
        usage={usage}
        range={rolling}
        rangeWindow="24h"
        timezone="Asia/Shanghai"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={onWindowChange}
      />,
    );

    expect(screen.getByText("Rolling usage")).toBeTruthy();

    const selector = screen.getByRole("group", { name: "Rolling usage window" });
    expect(within(selector).getByRole("button", { name: "24h" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(selector).getByRole("button", { name: "7d" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");

    expect(
      screen.getByRole("img", {
        name: "Requests trend for Codex · debitmetre-audit-v1 · request",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Input tokens trend for Codex · debitmetre-audit-v1 · request",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Output tokens trend for Codex · debitmetre-audit-v1 · request",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Cache hit rate trend for Codex · debitmetre-audit-v1 · request",
      }),
    ).toBeTruthy();

    const codex = screen.getByRole("group", {
      name: "Rolling usage for Codex · debitmetre-audit-v1 · request",
    });
    expect(within(codex).getAllByLabelText(/Cache hit rate \d/u).length).toBeGreaterThan(0);

    // Monthly breakdown remains visible below the rolling interval.
    expect(screen.getByText("Monthly breakdown · November 2026")).toBeTruthy();
  });

  it("keeps missing cache coverage unavailable while a measured zero stays 0%", () => {
    const base = buildPopulatedRange("UTC", "24h");
    const codex = base.series[0]!;
    const openCode = base.series[1]!;
    const missing: UsageRangeResponse = {
      ...base,
      series: [
        {
          ...codex,
          totals: {
            ...codex.totals,
            cache_hit_rate: null,
            cached_tokens: null,
            cached_counted: 0,
            unit_count: codex.totals.unit_count + 1,
          },
          points: codex.points.map((point) => ({ ...point, cache_hit_rate: null })),
        },
        {
          ...openCode,
          totals: { ...openCode.totals, cache_hit_rate: 0, cached_tokens: 0 },
          points: openCode.points.map((point) => ({ ...point, cache_hit_rate: 0 })),
        },
      ],
    };

    render(
      <UsageSection
        usage={usage}
        range={missing}
        rangeWindow="24h"
        timezone="UTC"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={() => undefined}
      />,
    );

    const codexGroup = screen.getByRole("group", {
      name: "Rolling usage for Codex · debitmetre-audit-v1 · request",
    });
    expect(
      within(codexGroup).getAllByLabelText("Cache hit rate unavailable").length,
    ).toBeGreaterThan(0);
    expect(within(codexGroup).getAllByText(/^\d+\/\d+$/u).length).toBeGreaterThan(0);

    const openCodeGroup = screen.getByRole("group", {
      name: "Rolling usage for OpenCode Go · orihsus-audit-v1 · request",
    });
    expect(within(openCodeGroup).getByLabelText("Cache hit rate 0%")).toBeTruthy();
  });

  it("shows an explicit empty rolling interval without inventing usage", () => {
    render(
      <UsageSection
        usage={usage}
        range={{ ...buildPopulatedRange("UTC", "7d"), series: [] }}
        rangeWindow="7d"
        timezone="UTC"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
        onWindowChange={() => undefined}
      />,
    );

    expect(screen.getByText(/No usage in this rolling last 7 days range/u)).toBeTruthy();
    expect(screen.getByText("Monthly breakdown · November 2026")).toBeTruthy();
  });
});
