import { z } from "zod";

import type {
  BalanceHistoryPoint,
  BalanceHistoryResponse,
  BalanceHistorySeries,
  BalanceView,
  BalanceWindowDelta,
  OverviewResponse,
  ProducerHealth,
} from "./index";

const balanceProviderSchema = z.enum(["openrouter", "deepseek"]);
const deltaWindowDaysSchema = z.union([z.literal(7), z.literal(30)]);

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

export const overviewResponseSchema: z.ZodType<OverviewResponse> = z.object({
  generated_at: z.string(),
  producers: z.array(producerHealthSchema),
  balances: z.array(balanceViewSchema),
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
