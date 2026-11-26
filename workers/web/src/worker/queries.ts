import {
  BALANCE_PROVIDERS,
  DEFAULT_TIMEZONE,
  DELTA_WINDOW_DAYS,
  USAGE_TOKEN_COLUMNS,
  currentMonthInTimeZone,
  localDateInTimeZone,
  monthRangeUtc,
  utcSecondIso,
} from "@bilan/shared";
import type {
  BalanceHistoryResponse,
  BalanceHistorySeries,
  BalanceProvider,
  BalanceView,
  BalanceWindowDelta,
  DailyUsageRow,
  DeltaWindowDays,
  MonthlyUsage,
  OverviewResponse,
  ProducerHealth,
  UsageBreakdownRow,
  UsageDailyResponse,
  UsageTokenColumn,
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

interface UsageAggregateRow {
  source: string;
  accounting_basis: string;
  unit_kind: string;
  actor_kind: string;
  actor_id: string;
  model: string;
  effort: string;
  unit_count: number;
  coverage_gaps: number;
  input_tokens: number | null;
  input_counted: number;
  cached_tokens: number | null;
  cached_counted: number;
  uncached_tokens: number | null;
  uncached_counted: number;
  cache_write_tokens: number | null;
  cache_write_counted: number;
  output_tokens: number | null;
  output_counted: number;
  reasoning_tokens: number | null;
  reasoning_counted: number;
}

interface UsageBucketRow extends UsageAggregateRow {
  bucket_start: string;
}

interface LatestUsageRow {
  latest: string | null;
}

const USAGE_STALE_AFTER_SECONDS = 2 * 60 * 60;

const TOKEN_COUNTED_COLUMNS = {
  input_tokens: "input_counted",
  cached_tokens: "cached_counted",
  uncached_tokens: "uncached_counted",
  cache_write_tokens: "cache_write_counted",
  output_tokens: "output_counted",
  reasoning_tokens: "reasoning_counted",
} as const;

function withCompleteness<T extends UsageAggregateRow>(
  row: T,
): T & { is_partial: boolean; partial_columns: Array<UsageTokenColumn> } {
  const partialColumns = USAGE_TOKEN_COLUMNS.filter(
    (column) => row[TOKEN_COUNTED_COLUMNS[column]] < row.unit_count,
  );
  return {
    ...row,
    partial_columns: [...partialColumns],
    is_partial: row.coverage_gaps > 0 || partialColumns.length > 0,
  };
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

async function loadMonthlyUsage(
  db: D1Database,
  timezone: string,
  month: string,
  now: Date,
): Promise<MonthlyUsage> {
  const range = monthRangeUtc(month, timezone);
  const nowIso = utcSecondIso(now);
  const [usage, latest] = await Promise.all([
    db
      .prepare(
        `SELECT source, accounting_basis, unit_kind, actor_kind, actor_id, model, effort,
                SUM(unit_count) AS unit_count,
                SUM(coverage_gaps) AS coverage_gaps,
                SUM(input_tokens) AS input_tokens,
                SUM(input_counted) AS input_counted,
                SUM(cached_tokens) AS cached_tokens,
                SUM(cached_counted) AS cached_counted,
                SUM(uncached_tokens) AS uncached_tokens,
                SUM(uncached_counted) AS uncached_counted,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_write_counted) AS cache_write_counted,
                SUM(output_tokens) AS output_tokens,
                SUM(output_counted) AS output_counted,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(reasoning_counted) AS reasoning_counted
         FROM usage_buckets
         WHERE bucket_start >= ? AND bucket_start < ?
         GROUP BY source, accounting_basis, unit_kind, actor_kind, actor_id, model, effort
         ORDER BY source, actor_kind, actor_id, model, effort, accounting_basis, unit_kind`,
      )
      .bind(range.start, range.end)
      .all<UsageAggregateRow>(),
    db
      .prepare("SELECT MAX(bucket_start) AS latest FROM usage_buckets WHERE bucket_start <= ?")
      .bind(nowIso)
      .first<LatestUsageRow>(),
  ]);

  const rows: Array<UsageBreakdownRow> = usage.results.map((row) => withCompleteness(row));
  const latestBucketStart = latest?.latest ?? null;
  const dataAge = latestBucketStart === null ? null : ageSeconds(now.getTime(), latestBucketStart);

  return {
    timezone,
    month,
    latest_bucket_start: latestBucketStart,
    data_age_seconds: dataAge,
    is_stale: dataAge === null || dataAge > USAGE_STALE_AFTER_SECONDS,
    rows,
  };
}

async function loadDailyUsage(
  db: D1Database,
  timezone: string,
  month: string,
): Promise<Array<DailyUsageRow>> {
  const range = monthRangeUtc(month, timezone);
  const result = await db
    .prepare(
      `SELECT bucket_start, source, accounting_basis, unit_kind, actor_kind, actor_id,
              model, effort, unit_count, coverage_gaps,
              input_tokens, input_counted, cached_tokens, cached_counted,
              uncached_tokens, uncached_counted, cache_write_tokens, cache_write_counted,
              output_tokens, output_counted, reasoning_tokens, reasoning_counted
       FROM usage_buckets
       WHERE bucket_start >= ? AND bucket_start < ?
       ORDER BY bucket_start, source, accounting_basis, unit_kind`,
    )
    .bind(range.start, range.end)
    .all<UsageBucketRow>();

  const accumulators = new Map<string, UsageAggregateRow & { date: string }>();
  for (const bucket of result.results) {
    const date = localDateInTimeZone(bucket.bucket_start, timezone);
    const key = `${bucket.source}\u0000${bucket.accounting_basis}\u0000${bucket.unit_kind}\u0000${date}`;
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = {
        source: bucket.source,
        accounting_basis: bucket.accounting_basis,
        unit_kind: bucket.unit_kind,
        actor_kind: "",
        actor_id: "",
        model: "",
        effort: "",
        unit_count: 0,
        coverage_gaps: 0,
        input_tokens: null,
        input_counted: 0,
        cached_tokens: null,
        cached_counted: 0,
        uncached_tokens: null,
        uncached_counted: 0,
        cache_write_tokens: null,
        cache_write_counted: 0,
        output_tokens: null,
        output_counted: 0,
        reasoning_tokens: null,
        reasoning_counted: 0,
        date,
      };
      accumulators.set(key, accumulator);
    }

    accumulator.unit_count += bucket.unit_count;
    accumulator.coverage_gaps += bucket.coverage_gaps;
    for (const column of USAGE_TOKEN_COLUMNS) {
      const countedKey = TOKEN_COUNTED_COLUMNS[column];
      const value = bucket[column];
      if (value !== null) {
        accumulator[column] = (accumulator[column] ?? 0) + value;
      }
      accumulator[countedKey] += bucket[countedKey];
    }
  }

  return [...accumulators.values()]
    .map((row) => withCompleteness(row))
    .map((row) => ({
      source: row.source,
      accounting_basis: row.accounting_basis,
      unit_kind: row.unit_kind,
      date: row.date,
      unit_count: row.unit_count,
      coverage_gaps: row.coverage_gaps,
      input_tokens: row.input_tokens,
      input_counted: row.input_counted,
      cached_tokens: row.cached_tokens,
      cached_counted: row.cached_counted,
      uncached_tokens: row.uncached_tokens,
      uncached_counted: row.uncached_counted,
      cache_write_tokens: row.cache_write_tokens,
      cache_write_counted: row.cache_write_counted,
      output_tokens: row.output_tokens,
      output_counted: row.output_counted,
      reasoning_tokens: row.reasoning_tokens,
      reasoning_counted: row.reasoning_counted,
      is_partial: row.is_partial,
      partial_columns: row.partial_columns,
    }))
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.source.localeCompare(right.source) ||
        left.accounting_basis.localeCompare(right.accounting_basis) ||
        left.unit_kind.localeCompare(right.unit_kind),
    );
}

export async function getOverview(
  db: D1Database,
  now: Date = new Date(),
  usageQuery: { timezone: string; month: string } = {
    timezone: DEFAULT_TIMEZONE,
    month: currentMonthInTimeZone(now, DEFAULT_TIMEZONE),
  },
): Promise<OverviewResponse> {
  const nowMs = now.getTime();
  const [producerRows, latestBalances, usage] = await Promise.all([
    loadProducers(db),
    loadLatestBalances(db),
    loadMonthlyUsage(db, usageQuery.timezone, usageQuery.month, now),
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
    usage,
  };
}

export async function getUsageDaily(
  db: D1Database,
  options: { timezone: string; month: string },
): Promise<UsageDailyResponse> {
  return {
    timezone: options.timezone,
    month: options.month,
    rows: await loadDailyUsage(db, options.timezone, options.month),
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
