import { z } from "zod";

import type {
  BalanceHistoryPoint,
  BalanceHistoryResponse,
  BalanceHistorySeries,
  BalanceView,
  BalanceWindowDelta,
  DailyUsageRow,
  MonthlyUsage,
  OverviewResponse,
  ProducerHealth,
  QuotaAttempt,
  QuotaObservation,
  QuotaResponse,
  QuotaSubject,
  QuotaWindow,
  UsageBreakdownRow,
  UsageDailyResponse,
  UsageSourceFreshness,
} from "./index";

const balanceProviderSchema = z.enum(["openrouter", "deepseek"]);
const deltaWindowDaysSchema = z.union([z.literal(7), z.literal(30)]);
const usageTokenColumnSchema = z.enum([
  "input_tokens",
  "cached_tokens",
  "uncached_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
]);

const producerHealthSchema: z.ZodType<ProducerHealth> = z.object({
  producer_id: z.string(),
  display_name: z.string(),
  mode: z.enum(["push", "pull"]),
  expected_interval_seconds: z.number().int().nonnegative(),
  last_heartbeat_at: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  last_status: z.enum(["ok", "error"]).nullable(),
  last_error: z.string().nullable(),
  heartbeat_age_seconds: z.number().nullable(),
  is_stale: z.boolean(),
});

const balanceWindowDeltaSchema: z.ZodType<BalanceWindowDelta> = z.object({
  window_days: deltaWindowDaysSchema,
  net_delta: z.number().nullable(),
  reported_usage_delta: z.number().nullable(),
  reported_usage_delta_discontinuity: z.boolean(),
  baseline_sampled_at: z.string().nullable(),
  actual_interval_seconds: z.number().nullable(),
  coverage: z.enum(["full", "partial", "unavailable"]),
  coverage_reason: z
    .enum(["missing_baseline", "missing_value", "stale_current_sample", "boundary_mismatch"])
    .nullable(),
  history_complete: z.boolean(),
});

const balanceViewSchema: z.ZodType<BalanceView> = z.object({
  producer_id: z.string(),
  provider: balanceProviderSchema,
  account: z.string(),
  currency: z.string(),
  sampled_at: z.string(),
  ingested_at: z.string(),
  total_balance: z.number().nullable(),
  topped_up_balance: z.number().nullable(),
  granted_balance: z.number().nullable(),
  cumulative_usage: z.number().nullable(),
  credit_limit: z.number().nullable(),
  is_available: z.boolean().nullable(),
  data_age_seconds: z.number().nullable(),
  is_stale: z.boolean(),
  deltas: z.array(balanceWindowDeltaSchema),
});

const usageCountersShape = {
  unit_count: z.number().int().nonnegative(),
  coverage_gaps: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative().nullable(),
  input_counted: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().nullable(),
  cached_counted: z.number().int().nonnegative(),
  uncached_tokens: z.number().int().nonnegative().nullable(),
  uncached_counted: z.number().int().nonnegative(),
  cache_write_tokens: z.number().int().nonnegative().nullable(),
  cache_write_counted: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative().nullable(),
  output_counted: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative().nullable(),
  reasoning_counted: z.number().int().nonnegative(),
} as const;

const usageBreakdownRowSchema: z.ZodType<UsageBreakdownRow> = z.object({
  source: z.string(),
  accounting_basis: z.string(),
  unit_kind: z.string(),
  actor_kind: z.string(),
  actor_id: z.string(),
  model: z.string(),
  effort: z.string(),
  is_partial: z.boolean(),
  partial_columns: z.array(usageTokenColumnSchema),
  ...usageCountersShape,
});

const usageSourceFreshnessSchema: z.ZodType<UsageSourceFreshness> = z.object({
  source: z.string(),
  latest_bucket_start: z.string().nullable(),
  data_age_seconds: z.number().nullable(),
  is_stale: z.boolean(),
});

const monthlyUsageSchema: z.ZodType<MonthlyUsage> = z.object({
  timezone: z.string(),
  month: z.string(),
  bucket_attribution: z.enum(["exact", "approximate"]),
  bucket_attribution_note: z.string().nullable(),
  latest_bucket_start: z.string().nullable(),
  data_age_seconds: z.number().nullable(),
  is_stale: z.boolean(),
  source_freshness: z.array(usageSourceFreshnessSchema),
  rows: z.array(usageBreakdownRowSchema),
});

const dailyUsageRowSchema: z.ZodType<DailyUsageRow> = z.object({
  source: z.string(),
  accounting_basis: z.string(),
  unit_kind: z.string(),
  date: z.string(),
  is_partial: z.boolean(),
  partial_columns: z.array(usageTokenColumnSchema),
  ...usageCountersShape,
});

export const usageDailyResponseSchema: z.ZodType<UsageDailyResponse> = z.object({
  timezone: z.string(),
  month: z.string(),
  bucket_attribution: z.enum(["exact", "approximate"]),
  bucket_attribution_note: z.string().nullable(),
  rows: z.array(dailyUsageRowSchema),
});

const quotaWindowSchema: z.ZodType<QuotaWindow> = z.object({
  bucket_id: z.string(),
  slot: z.string(),
  label: z.string().nullable(),
  used_percent: z.number().nullable(),
  remaining_percent: z.number().nullable(),
  status: z.enum(["ok", "limited", "cooldown", "unknown"]).nullable(),
  resets_at: z.string().nullable(),
  reset_in_seconds: z.number().nullable(),
  window_duration_mins: z.number().nullable(),
});

const quotaObservationSchema: z.ZodType<QuotaObservation> = z.object({
  sample_id: z.string(),
  observer_machine: z.string(),
  sampled_at: z.string(),
  interval_seconds: z.number().nullable(),
  sample_age_seconds: z.number().nullable(),
  is_stale: z.boolean(),
  status: z.enum(["ok", "empty", "error"]),
  time_anomaly: z.string().nullable(),
  error_summary: z.string().nullable(),
  windows: z.array(quotaWindowSchema),
});

const quotaAttemptSchema: z.ZodType<QuotaAttempt> = z.object({
  sample_id: z.string(),
  observer_machine: z.string(),
  sampled_at: z.string(),
  sample_age_seconds: z.number().nullable(),
  status: z.enum(["ok", "empty", "error"]),
  time_anomaly: z.string().nullable(),
  error_summary: z.string().nullable(),
});

const quotaSubjectSchema: z.ZodType<QuotaSubject> = z.object({
  source: z.string(),
  account: z.string(),
  latest_valid: quotaObservationSchema.nullable(),
  latest_attempt: quotaAttemptSchema.nullable(),
  anomalies: z.array(quotaAttemptSchema),
});

export const quotaResponseSchema: z.ZodType<QuotaResponse> = z.object({
  generated_at: z.string(),
  subjects: z.array(quotaSubjectSchema),
});

export const overviewResponseSchema: z.ZodType<OverviewResponse> = z.object({
  generated_at: z.string(),
  producers: z.array(producerHealthSchema),
  balances: z.array(balanceViewSchema),
  usage: monthlyUsageSchema,
  quotas: quotaResponseSchema,
});

const balanceHistoryPointSchema: z.ZodType<BalanceHistoryPoint> = z.object({
  sampled_at: z.string(),
  ingested_at: z.string(),
  total_balance: z.number().nullable(),
  cumulative_usage: z.number().nullable(),
});

const balanceHistorySeriesSchema: z.ZodType<BalanceHistorySeries> = z.object({
  account: z.string(),
  currency: z.string(),
  points: z.array(balanceHistoryPointSchema),
});

export const balanceHistoryResponseSchema: z.ZodType<BalanceHistoryResponse> = z.object({
  provider: balanceProviderSchema,
  days: z.number().int().positive(),
  series: z.array(balanceHistorySeriesSchema),
});
