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

export interface BalanceWindowDelta {
  window_days: DeltaWindowDays;
  /** A balance-only difference. Never a spend or burn total. */
  net_delta: number | null;
  /** Only present when the provider reports monotonic cumulative usage. */
  reported_usage_delta: number | null;
  reported_usage_delta_discontinuity: boolean;
  baseline_sampled_at: string | null;
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

export interface OverviewResponse {
  generated_at: string;
  producers: Array<ProducerHealth>;
  balances: Array<BalanceView>;
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
