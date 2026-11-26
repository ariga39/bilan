import type { BalanceHistorySeries } from "@bilan/shared";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BalanceHistoryChart } from "@/components/balance-history-chart";
import { buildBalanceChartPoints } from "@/lib/chart";

interface CapturedXAxisProps {
  dataKey?: unknown;
  type?: unknown;
  scale?: unknown;
}

const captured = vi.hoisted(() => ({
  xAxisProps: null as CapturedXAxisProps | null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: (props: CapturedXAxisProps) => {
    captured.xAxisProps = props;
    return null;
  },
  YAxis: () => null,
  Tooltip: () => null,
  Line: () => null,
}));

afterEach(cleanup);

const series: BalanceHistorySeries = {
  account: "default",
  currency: "USD",
  points: [
    {
      sampled_at: "2026-11-01T00:00:00Z",
      ingested_at: "2026-11-01T00:00:00Z",
      total_balance: 10,
      cumulative_usage: 1,
    },
    {
      sampled_at: "2026-11-01T00:30:00Z",
      ingested_at: "2026-11-01T00:30:00Z",
      total_balance: 9,
      cumulative_usage: 2,
    },
    {
      sampled_at: "2026-11-04T00:00:00Z",
      ingested_at: "2026-11-04T00:00:00Z",
      total_balance: 8,
      cumulative_usage: 3,
    },
  ],
};

describe("balance history time axis", () => {
  it("plots samples as numeric timestamps on a time scale", () => {
    render(<BalanceHistoryChart provider="openrouter" series={series} />);

    expect(captured.xAxisProps).toMatchObject({
      dataKey: "sampled_at_ms",
      type: "number",
      scale: "time",
    });

    const points = buildBalanceChartPoints(series);
    expect(points).toHaveLength(3);
    expect((points[1]?.sampled_at_ms ?? 0) - (points[0]?.sampled_at_ms ?? 0)).toBe(30 * 60_000);
    expect((points[2]?.sampled_at_ms ?? 0) - (points[0]?.sampled_at_ms ?? 0)).toBe(3 * 86_400_000);
  });
});
