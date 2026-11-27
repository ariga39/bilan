import type { DailyUsageRow, MonthlyUsage, UsageDailyResponse } from "@bilan/shared";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageSection } from "@/components/usage-section";

interface CapturedXAxisProps {
  dataKey?: unknown;
  type?: unknown;
  domain?: unknown;
  allowDecimals?: unknown;
}

interface CapturedLineProps {
  dataKey?: unknown;
  type?: unknown;
  connectNulls?: unknown;
}

interface CapturedLineChartProps {
  data?: Array<TrendPoint> | undefined;
}

interface TrendPoint {
  day: number;
  date: string;
  requests: number | null;
}

const captured = vi.hoisted(() => ({
  xAxisProps: null as CapturedXAxisProps | null,
  lineProps: null as CapturedLineProps | null,
  lineChartProps: null as CapturedLineChartProps | null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({
    data,
    children,
  }: {
    data?: Array<TrendPoint> | undefined;
    children: ReactNode;
  }) => {
    captured.lineChartProps = { data };
    return <div>{children}</div>;
  },
  CartesianGrid: () => null,
  XAxis: (props: CapturedXAxisProps) => {
    captured.xAxisProps = props;
    return null;
  },
  YAxis: () => null,
  Tooltip: () => null,
  Line: (props: CapturedLineProps) => {
    captured.lineProps = props;
    return null;
  },
}));

afterEach(cleanup);

function dailyRow(date: string, unitCount: number): DailyUsageRow {
  return {
    source: "codex",
    accounting_basis: "debitmetre-audit-v1",
    unit_kind: "request",
    date,
    unit_count: unitCount,
    coverage_gaps: 0,
    input_tokens: unitCount * 10,
    input_counted: unitCount,
    cached_tokens: 0,
    cached_counted: unitCount,
    uncached_tokens: unitCount * 10,
    uncached_counted: unitCount,
    cache_write_tokens: 0,
    cache_write_counted: unitCount,
    output_tokens: unitCount * 5,
    output_counted: unitCount,
    reasoning_tokens: 0,
    reasoning_counted: unitCount,
    is_partial: false,
    partial_columns: [],
  };
}

function monthlyUsage(
  timezone: string,
  month: string,
  latestBucketStart: string | null,
): MonthlyUsage {
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    latest_bucket_start: latestBucketStart,
    data_age_seconds: latestBucketStart === null ? null : 60,
    is_stale: false,
    source_freshness: [],
    rows: [],
  };
}

function dailyUsage(
  timezone: string,
  month: string,
  rows: Array<DailyUsageRow>,
): UsageDailyResponse {
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    rows,
  };
}

describe("daily usage trend calendar axis", () => {
  it("keeps every calendar day on the axis with null gaps and observed zeros intact", () => {
    render(
      <UsageSection
        usage={monthlyUsage("Asia/Shanghai", "2026-11", "2026-11-21T00:00:00Z")}
        daily={dailyUsage("Asia/Shanghai", "2026-11", [
          dailyRow("2026-11-05", 0),
          dailyRow("2026-11-20", 7),
          dailyRow("2026-11-21", 3),
        ])}
        timezone="Asia/Shanghai"
        month="2026-11"
        generatedAt="2026-11-27T12:00:00Z"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(captured.xAxisProps).toMatchObject({
      dataKey: "day",
      type: "number",
      domain: [1, 30],
      allowDecimals: false,
    });
    expect(captured.lineProps).toMatchObject({
      dataKey: "requests",
      type: "linear",
      connectNulls: false,
    });

    const points = captured.lineChartProps?.data;
    expect(points).toBeDefined();
    if (!points) {
      throw new Error("daily trend chart data was not captured");
    }
    expect(points).toHaveLength(30);
    expect(points.filter((point) => point.requests !== null)).toHaveLength(3);
    expect(points[0]).toEqual({ day: 1, date: "2026-11-01", requests: null });
    expect(points[4]).toEqual({ day: 5, date: "2026-11-05", requests: 0 });
    expect(points[19]).toEqual({ day: 20, date: "2026-11-20", requests: 7 });
    expect(points[20]).toEqual({ day: 21, date: "2026-11-21", requests: 3 });
    expect(points[29]).toEqual({ day: 30, date: "2026-11-30", requests: null });
  });

  it("uses the selected timezone month length and leaves other days unobserved", () => {
    render(
      <UsageSection
        usage={monthlyUsage("Asia/Kolkata", "2026-02", "2026-02-15T00:00:00Z")}
        daily={dailyUsage("Asia/Kolkata", "2026-02", [dailyRow("2026-02-15", 4)])}
        timezone="Asia/Kolkata"
        month="2026-02"
        generatedAt="2026-02-20T12:00:00Z"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );

    expect(captured.xAxisProps).toMatchObject({
      dataKey: "day",
      type: "number",
      domain: [1, 28],
      allowDecimals: false,
    });

    const points = captured.lineChartProps?.data;
    expect(points).toBeDefined();
    if (!points) {
      throw new Error("daily trend chart data was not captured");
    }
    expect(points).toHaveLength(28);
    expect(points.filter((point) => point.requests !== null)).toHaveLength(1);
    expect(points[14]).toEqual({ day: 15, date: "2026-02-15", requests: 4 });
    expect(points[27]).toEqual({ day: 28, date: "2026-02-28", requests: null });
  });
});
