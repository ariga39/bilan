import type { BalanceHistorySeries } from "@bilan/shared";

export interface BalanceChartPoint {
  sampled_at_ms: number;
  total_balance: number;
}

export function buildBalanceChartPoints(series: BalanceHistorySeries): Array<BalanceChartPoint> {
  return series.points.flatMap((point) => {
    if (point.total_balance === null) {
      return [];
    }

    const sampledAtMs = Date.parse(point.sampled_at);
    if (Number.isNaN(sampledAtMs)) {
      return [];
    }

    return [{ sampled_at_ms: sampledAtMs, total_balance: point.total_balance }];
  });
}
