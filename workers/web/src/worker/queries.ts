import { BALANCE_PROVIDERS, DELTA_WINDOW_DAYS } from "@bilan/shared";
import type {
  BalanceHistoryResponse,
  BalanceHistorySeries,
  BalanceProvider,
  BalanceView,
  BalanceWindowDelta,
  DeltaWindowDays,
  OverviewResponse,
  ProducerHealth,
} from "@bilan/shared";

interface ProducerRow {
  producer_id: string;
  mode: string;
  display_name: string;
  expected_interval_seconds: number;
  last_heartbeat_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

interface LatestBalanceRow {
  producer_id: string;
  provider: string;
  account: string;
  currency: string;
  sampled_at: string;
  ingested_at: string;
  total_balance: number | null;
  topped_up_balance: number | null;
  granted_balance: number | null;
  cumulative_usage: number | null;
  credit_limit: number | null;
  is_available: number | null;
}

interface BaselineRow {
  sampled_at: string;
  total_balance: number | null;
  cumulative_usage: number | null;
}

interface HistoryRow {
  account: string;
  currency: string;
  sampled_at: string;
  ingested_at: string;
  total_balance: number | null;
  cumulative_usage: number | null;
}

interface CumulativeUsageRow {
  cumulative_usage: number | null;
}

const DAY_MS = 86_400_000;

export function isBalanceProvider(value: string | undefined): value is BalanceProvider {
  return value !== undefined && BALANCE_PROVIDERS.some((provider) => provider === value);
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ageSeconds(nowMs: number, timestamp: string): number | null {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) {
    return null;
  }
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function producerStatus(value: string | null): "ok" | "error" | null {
  return value === "ok" || value === "error" ? value : null;
}

async function loadProducers(db: D1Database): Promise<Array<ProducerRow>> {
  const result = await db
    .prepare(
      `SELECT producer_id, mode, display_name, expected_interval_seconds,
              last_heartbeat_at, last_attempt_at, last_status, last_error
       FROM producers
       ORDER BY producer_id`,
    )
    .all<ProducerRow>();
  return result.results;
}

async function loadLatestBalances(db: D1Database): Promise<Array<LatestBalanceRow>> {
  const result = await db
    .prepare(
      `SELECT producer_id, provider, account, currency, sampled_at, ingested_at,
              total_balance, topped_up_balance, granted_balance,
              cumulative_usage, credit_limit, is_available
       FROM (
         SELECT b.*,
                ROW_NUMBER() OVER (
                  PARTITION BY provider, account, currency
                  ORDER BY sampled_at DESC, ingested_at DESC
                ) AS row_number
         FROM balance_snapshots b
       )
       WHERE row_number = 1
       ORDER BY provider, currency, account`,
    )
    .all<LatestBalanceRow>();
  return result.results;
}

async function loadBaseline(
  db: D1Database,
  balance: LatestBalanceRow,
  windowDays: DeltaWindowDays,
  nowMs: number,
): Promise<BaselineRow | null> {
  const cutoff = new Date(nowMs - windowDays * DAY_MS).toISOString();
  return db
    .prepare(
      `SELECT sampled_at, total_balance, cumulative_usage
       FROM balance_snapshots
       WHERE provider = ? AND account = ? AND currency = ?
         AND sampled_at < ?
         AND sampled_at <= ?
       ORDER BY sampled_at DESC
       LIMIT 1`,
    )
    .bind(balance.provider, balance.account, balance.currency, balance.sampled_at, cutoff)
    .first<BaselineRow>();
}

async function hasCumulativeUsageDecrease(
  db: D1Database,
  balance: LatestBalanceRow,
  baseline: BaselineRow,
): Promise<boolean> {
  // A reset inside the window can still leave latest - baseline positive.
  const result = await db
    .prepare(
      `SELECT cumulative_usage
       FROM balance_snapshots
       WHERE provider = ? AND account = ? AND currency = ?
         AND sampled_at >= ? AND sampled_at <= ?
         AND cumulative_usage IS NOT NULL
       ORDER BY sampled_at, ingested_at`,
    )
    .bind(
      balance.provider,
      balance.account,
      balance.currency,
      baseline.sampled_at,
      balance.sampled_at,
    )
    .all<CumulativeUsageRow>();

  let previous: number | null = null;
  for (const row of result.results) {
    if (row.cumulative_usage === null) {
      continue;
    }
    if (previous !== null && row.cumulative_usage < previous) {
      return true;
    }
    previous = row.cumulative_usage;
  }

  return false;
}

async function loadDelta(
  db: D1Database,
  balance: LatestBalanceRow,
  windowDays: DeltaWindowDays,
  nowMs: number,
  expectedIntervalSeconds: number,
): Promise<BalanceWindowDelta> {
  const baseline = await loadBaseline(db, balance, windowDays, nowMs);
  const windowMs = windowDays * DAY_MS;
  const cutoffMs = nowMs - windowMs;
  const toleranceMs = Math.max(1, expectedIntervalSeconds) * 2 * 1000;
  const currentMs = parseTimestamp(balance.sampled_at);
  const baselineMs = baseline === null ? null : parseTimestamp(baseline.sampled_at);

  const actualIntervalSeconds =
    currentMs !== null && baselineMs !== null
      ? Math.max(0, Math.round((currentMs - baselineMs) / 1000))
      : null;

  const netDelta =
    baseline !== null && balance.total_balance !== null && baseline.total_balance !== null
      ? balance.total_balance - baseline.total_balance
      : null;

  const reportedUsageDelta =
    baseline !== null && balance.cumulative_usage !== null && baseline.cumulative_usage !== null
      ? balance.cumulative_usage - baseline.cumulative_usage
      : null;
  const reportedUsageDiscontinuity =
    baseline !== null ? await hasCumulativeUsageDecrease(db, balance, baseline) : false;

  let coverage: BalanceWindowDelta["coverage"] = "full";
  let coverageReason: BalanceWindowDelta["coverage_reason"] = null;

  if (baseline === null) {
    coverage = "unavailable";
    coverageReason = "missing_baseline";
  } else if (netDelta === null) {
    coverage = "unavailable";
    coverageReason = "missing_value";
  } else if (currentMs === null || Math.abs(nowMs - currentMs) > toleranceMs) {
    coverage = "partial";
    coverageReason = "stale_current_sample";
  } else if (baselineMs === null || Math.abs(cutoffMs - baselineMs) > toleranceMs) {
    coverage = "partial";
    coverageReason = "boundary_mismatch";
  }

  return {
    window_days: windowDays,
    net_delta: netDelta,
    reported_usage_delta: reportedUsageDelta,
    reported_usage_delta_discontinuity: reportedUsageDiscontinuity,
    baseline_sampled_at: baseline?.sampled_at ?? null,
    actual_interval_seconds: actualIntervalSeconds,
    coverage,
    coverage_reason: coverageReason,
    history_complete: coverage === "full",
  };
}

function toProducerHealth(row: ProducerRow, nowMs: number): ProducerHealth {
  const heartbeatAge = row.last_heartbeat_at ? ageSeconds(nowMs, row.last_heartbeat_at) : null;
  const staleAfter = row.expected_interval_seconds * 2;

  return {
    producer_id: row.producer_id,
    display_name: row.display_name,
    mode: row.mode === "push" ? "push" : "pull",
    expected_interval_seconds: row.expected_interval_seconds,
    last_heartbeat_at: row.last_heartbeat_at,
    last_attempt_at: row.last_attempt_at,
    last_status: producerStatus(row.last_status),
    last_error: row.last_error,
    heartbeat_age_seconds: heartbeatAge,
    is_stale: heartbeatAge === null || heartbeatAge > staleAfter,
  };
}

export async function getOverview(
  db: D1Database,
  now: Date = new Date(),
): Promise<OverviewResponse> {
  const nowMs = now.getTime();
  const [producerRows, latestBalances] = await Promise.all([
    loadProducers(db),
    loadLatestBalances(db),
  ]);
  const producerIntervals = new Map(
    producerRows.map((row) => [row.producer_id, row.expected_interval_seconds]),
  );

  const balances = (
    await Promise.all(
      latestBalances.map(async (row): Promise<BalanceView | null> => {
        if (!isBalanceProvider(row.provider)) {
          return null;
        }

        const dataAge = ageSeconds(nowMs, row.sampled_at);
        const expectedInterval = producerIntervals.get(row.producer_id) ?? 1800;
        const deltas = await Promise.all(
          DELTA_WINDOW_DAYS.map((windowDays) =>
            loadDelta(db, row, windowDays, nowMs, expectedInterval),
          ),
        );

        return {
          producer_id: row.producer_id,
          provider: row.provider,
          account: row.account,
          currency: row.currency,
          sampled_at: row.sampled_at,
          ingested_at: row.ingested_at,
          total_balance: row.total_balance,
          topped_up_balance: row.topped_up_balance,
          granted_balance: row.granted_balance,
          cumulative_usage: row.cumulative_usage,
          credit_limit: row.credit_limit,
          is_available: row.is_available === null ? null : row.is_available === 1,
          data_age_seconds: dataAge,
          is_stale: dataAge === null || dataAge > expectedInterval * 2,
          deltas,
        };
      }),
    )
  ).filter((balance): balance is BalanceView => balance !== null);

  return {
    generated_at: now.toISOString(),
    producers: producerRows.map((row) => toProducerHealth(row, nowMs)),
    balances,
  };
}

export async function getBalanceHistory(
  db: D1Database,
  provider: BalanceProvider,
  days: number,
  now: Date = new Date(),
): Promise<BalanceHistoryResponse> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const result = await db
    .prepare(
      `SELECT account, currency, sampled_at, ingested_at,
              total_balance, cumulative_usage
       FROM balance_snapshots
       WHERE provider = ? AND sampled_at >= ?
       ORDER BY sampled_at`,
    )
    .bind(provider, cutoff)
    .all<HistoryRow>();

  const seriesByKey = new Map<string, BalanceHistorySeries>();
  for (const row of result.results) {
    const key = `${row.account}\u0000${row.currency}`;
    let series = seriesByKey.get(key);
    if (!series) {
      series = { account: row.account, currency: row.currency, points: [] };
      seriesByKey.set(key, series);
    }
    series.points.push({
      sampled_at: row.sampled_at,
      ingested_at: row.ingested_at,
      total_balance: row.total_balance,
      cumulative_usage: row.cumulative_usage,
    });
  }

  const series = [...seriesByKey.values()].sort(
    (left, right) =>
      left.currency.localeCompare(right.currency) || left.account.localeCompare(right.account),
  );

  return { provider, days, series };
}
