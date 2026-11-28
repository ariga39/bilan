import type { BucketAttribution } from "./time";

export * from "./time";
export * from "./quota-visibility";

export const BALANCE_PROVIDERS = ["openrouter", "deepseek"] as const;
export type BalanceProvider = (typeof BALANCE_PROVIDERS)[number];

export const DELTA_WINDOW_DAYS = [7, 30] as const;
export type DeltaWindowDays = (typeof DELTA_WINDOW_DAYS)[number];

export const PULL_PRODUCER_CONFIG: Record<
  BalanceProvider,
  {
    producerId: string;
    displayName: string;
    expectedIntervalSeconds: number;
  }
> = {
  openrouter: {
    producerId: "pull-openrouter",
    displayName: "OpenRouter balance",
    expectedIntervalSeconds: 1800,
  },
  deepseek: {
    producerId: "pull-deepseek",
    displayName: "DeepSeek balance",
    expectedIntervalSeconds: 1800,
  },
};

export interface BalanceSnapshotInput {
  provider: BalanceProvider;
  account: string;
  currency: string;
  sampled_at: string;
  total_balance: number | null;
  topped_up_balance: number | null;
  granted_balance: number | null;
  cumulative_usage: number | null;
  credit_limit: number | null;
  is_available: boolean | null;
}

export interface ProducerHealth {
  producer_id: string;
  display_name: string;
  mode: "push" | "pull";
  expected_interval_seconds: number;
  last_heartbeat_at: string | null;
  last_attempt_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  heartbeat_age_seconds: number | null;
  is_stale: boolean;
}

export type DeltaCoverage = "full" | "partial" | "unavailable";

export type DeltaCoverageReason =
  | "missing_baseline"
  | "missing_value"
  | "stale_current_sample"
  | "boundary_mismatch";

export interface BalanceWindowDelta {
  window_days: DeltaWindowDays;
  /** A balance-only difference. Never a spend or burn total. */
  net_delta: number | null;
  /** Only present when the provider reports monotonic cumulative usage. */
  reported_usage_delta: number | null;
  reported_usage_delta_discontinuity: boolean;
  baseline_sampled_at: string | null;
  /** Actual time between the baseline and current samples, not the nominal window. */
  actual_interval_seconds: number | null;
  coverage: DeltaCoverage;
  coverage_reason: DeltaCoverageReason | null;
  history_complete: boolean;
}

export interface BalanceView {
  producer_id: string;
  provider: BalanceProvider;
  account: string;
  currency: string;
  sampled_at: string;
  ingested_at: string;
  total_balance: number | null;
  topped_up_balance: number | null;
  granted_balance: number | null;
  cumulative_usage: number | null;
  credit_limit: number | null;
  is_available: boolean | null;
  data_age_seconds: number | null;
  is_stale: boolean;
  deltas: Array<BalanceWindowDelta>;
}

export type QuotaWindowStatus = "ok" | "limited" | "cooldown" | "unknown";
export type QuotaObservationStatus = "ok" | "empty" | "error";

export interface QuotaWindow {
  bucket_id: string;
  slot: string;
  label: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  status: QuotaWindowStatus | null;
  resets_at: string | null;
  reset_in_seconds: number | null;
  window_duration_mins: number | null;
}

export interface QuotaObservation {
  sample_id: string;
  observer_machine: string;
  sampled_at: string;
  interval_seconds: number | null;
  sample_age_seconds: number | null;
  is_stale: boolean;
  status: QuotaObservationStatus;
  time_anomaly: string | null;
  error_summary: string | null;
  windows: Array<QuotaWindow>;
}

export interface QuotaAttempt {
  sample_id: string;
  observer_machine: string;
  sampled_at: string;
  sample_age_seconds: number | null;
  status: QuotaObservationStatus;
  time_anomaly: string | null;
  error_summary: string | null;
}

export type QuotaAnomaly = QuotaAttempt;

export interface QuotaSubject {
  source: string;
  account: string;
  latest_valid: QuotaObservation | null;
  latest_attempt: QuotaAttempt | null;
  anomalies: Array<QuotaAnomaly>;
}

export interface QuotaResponse {
  generated_at: string;
  subjects: Array<QuotaSubject>;
}

export interface OverviewResponse {
  generated_at: string;
  producers: Array<ProducerHealth>;
  balances: Array<BalanceView>;
  usage: MonthlyUsage;
  quotas: QuotaResponse;
}

export interface BalanceHistoryPoint {
  sampled_at: string;
  ingested_at: string;
  total_balance: number | null;
  cumulative_usage: number | null;
}

export interface BalanceHistorySeries {
  account: string;
  currency: string;
  points: Array<BalanceHistoryPoint>;
}

export interface BalanceHistoryResponse {
  provider: BalanceProvider;
  days: number;
  series: Array<BalanceHistorySeries>;
}

export const USAGE_TOKEN_COLUMNS = [
  "input_tokens",
  "cached_tokens",
  "uncached_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
] as const;

export type UsageTokenColumn = (typeof USAGE_TOKEN_COLUMNS)[number];

export interface UsageCounters {
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

export interface UsageBreakdownRow extends UsageCounters {
  source: string;
  accounting_basis: string;
  unit_kind: string;
  actor_kind: string;
  actor_id: string;
  model: string;
  effort: string;
  is_partial: boolean;
  partial_columns: Array<UsageTokenColumn>;
}

export interface UsageSourceFreshness {
  source: string;
  latest_bucket_start: string | null;
  data_age_seconds: number | null;
  is_stale: boolean;
}

export interface MonthlyUsage {
  timezone: string;
  month: string;
  bucket_attribution: BucketAttribution;
  bucket_attribution_note: string | null;
  latest_bucket_start: string | null;
  data_age_seconds: number | null;
  is_stale: boolean;
  source_freshness: Array<UsageSourceFreshness>;
  rows: Array<UsageBreakdownRow>;
}

export interface DailyUsageRow extends UsageCounters {
  source: string;
  accounting_basis: string;
  unit_kind: string;
  date: string;
  is_partial: boolean;
  partial_columns: Array<UsageTokenColumn>;
}

export interface UsageDailyResponse {
  timezone: string;
  month: string;
  bucket_attribution: BucketAttribution;
  bucket_attribution_note: string | null;
  rows: Array<DailyUsageRow>;
}

export const USAGE_RANGE_WINDOWS = ["24h", "7d", "30d"] as const;
export type UsageRangeWindow = (typeof USAGE_RANGE_WINDOWS)[number];

export const USAGE_RANGE_HOURS: Record<UsageRangeWindow, number> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
};

export type UsageRangeGranularity = "hour" | "day";

export function isUsageRangeWindow(value: unknown): value is UsageRangeWindow {
  return typeof value === "string" && USAGE_RANGE_WINDOWS.some((candidate) => candidate === value);
}

export function usageRangeHours(window: UsageRangeWindow): number {
  return USAGE_RANGE_HOURS[window];
}

export interface UsageRangePoint extends UsageCounters {
  /** UTC hour start for hourly points; the first UTC hour in the local date for daily points. */
  start: string;
  /** Local calendar date used for daily points and chart labels. */
  date: string;
  cache_hit_rate: number | null;
  is_partial: boolean;
  partial_columns: Array<UsageTokenColumn>;
  includes_current_hour: boolean;
}

export interface UsageRangeTotals extends UsageCounters {
  cache_hit_rate: number | null;
  is_partial: boolean;
  partial_columns: Array<UsageTokenColumn>;
}

export interface UsageRangeSeries {
  source: string;
  accounting_basis: string;
  unit_kind: string;
  points: Array<UsageRangePoint>;
  totals: UsageRangeTotals;
}

export interface UsageRangeResponse {
  generated_at: string;
  timezone: string;
  window: UsageRangeWindow;
  granularity: UsageRangeGranularity;
  /** Inclusive UTC hour boundary of the first bucket in the range. */
  range_start: string;
  /** Exclusive UTC hour boundary after the current partial hour. */
  range_end: string;
  /** UTC hour containing the request instant; the range always includes it. */
  current_hour_start: string;
  bucket_attribution: BucketAttribution;
  bucket_attribution_note: string | null;
  series: Array<UsageRangeSeries>;
}

/**
 * Cache hit rate is the weighted cached-token share of input tokens. It is
 * unavailable unless both counters were reported over the same requests and
 * the input denominator is positive, so missing coverage never becomes 0%.
 */
export function cacheHitRate(
  counters: Pick<
    UsageCounters,
    | "unit_count"
    | "coverage_gaps"
    | "input_tokens"
    | "input_counted"
    | "cached_tokens"
    | "cached_counted"
  >,
): number | null {
  if (
    counters.input_tokens === null ||
    counters.cached_tokens === null ||
    counters.input_tokens <= 0 ||
    counters.input_counted <= 0 ||
    counters.input_counted !== counters.cached_counted ||
    // Every complete request has both counters. Equal partial counts alone
    // do not establish that input and cache came from the same requests.
    (counters.input_counted !== counters.unit_count &&
      counters.input_counted !== counters.unit_count - counters.coverage_gaps)
  ) {
    return null;
  }
  return counters.cached_tokens / counters.input_tokens;
}
