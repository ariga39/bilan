import type { UsageRangeResponse } from "@bilan/shared";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RollingUsageSection } from "@/components/usage-range";
import { buildPopulatedRange } from "@/stories/fixtures";

interface CapturedBar {
  dataKey?: unknown;
}

interface CapturedArea {
  dataKey?: unknown;
}

interface CapturedChartData {
  kind: "bar" | "area";
  data: Array<{ label: string; requests: number | null; cacheHitRate: number | null }> | undefined;
}

const captured = vi.hoisted(() => ({
  charts: [] as Array<CapturedChartData>,
  bars: [] as Array<CapturedBar>,
  areas: [] as Array<CapturedArea>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data, children }: { data?: CapturedChartData["data"]; children: ReactNode }) => {
    captured.charts.push({ kind: "bar", data });
    return <div>{children}</div>;
  },
  AreaChart: ({ data, children }: { data?: CapturedChartData["data"]; children: ReactNode }) => {
    captured.charts.push({ kind: "area", data });
    return <div>{children}</div>;
  },
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Bar: (props: CapturedBar) => {
    captured.bars.push(props);
    return null;
  },
  Area: (props: CapturedArea) => {
    captured.areas.push(props);
    return null;
  },
}));

afterEach(() => {
  cleanup();
  captured.charts.length = 0;
  captured.bars.length = 0;
  captured.areas.length = 0;
});

describe("rolling usage charts", () => {
  it("renders volume metrics as bar charts and cache hit rate as an area chart while preserving null gaps", () => {
    const base = buildPopulatedRange("Asia/Shanghai", "7d");
    const codex = base.series[0]!;
    const sparse: UsageRangeResponse = {
      ...base,
      series: [
        {
          ...codex,
          points: codex.points.slice(0, 2),
        },
      ],
    };

    render(
      <RollingUsageSection
        range={sparse}
        window="7d"
        mode="compact"
        onWindowChange={() => undefined}
      />,
    );

    expect(captured.bars.map((bar) => bar.dataKey)).toEqual(["requests", "input", "output"]);
    expect(captured.areas.map((area) => area.dataKey)).toEqual(["cacheHitRate"]);

    const requestChart = captured.charts.find((chart) => chart.kind === "bar");
    expect(requestChart?.data).toBeDefined();
    expect(requestChart?.data?.length).toBeGreaterThan(2);
    expect(requestChart?.data?.some((point) => point.requests === null)).toBe(true);
    expect(requestChart?.data?.filter((point) => point.requests !== null)).toHaveLength(2);
  });
});
