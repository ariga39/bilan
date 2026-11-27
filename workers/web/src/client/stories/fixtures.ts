import type {
  BalanceHistoryPoint,
  BalanceHistoryResponse,
  BalanceProvider,
  BalanceView,
  BalanceWindowDelta,
  DailyUsageRow,
  MonthlyUsage,
  OverviewResponse,
  ProducerHealth,
  QuotaAttempt,
  QuotaObservation,
  QuotaSubject,
  QuotaWindow,
  UsageBreakdownRow,
  UsageCounters,
  UsageDailyResponse,
  UsageTokenColumn,
} from "@bilan/shared";

/**
 * Storybook fixtures are synthetic and deterministic. They are only imported by
 * stories and the Storybook preview, never by the application entry point.
 */
export const FIXED_NOW = "2026-11-27T12:00:00Z";
export const FIXTURE_MONTH = "2026-11";
export const FIXTURE_TIMEZONE = "Asia/Shanghai";

const NOW = FIXED_NOW;
const DAY_MS = 86_400_000;

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

interface CounterInput {
  unitCount: number;
  input: number | null;
  cached?: number | null;
  uncached?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  reasoning?: number | null;
  coverageGaps?: number;
}

function counters(input: CounterInput): UsageCounters {
  const optionalCounted = (value: number | null | undefined): number =>
    value === null || value === undefined ? 0 : input.unitCount;

  return {
    unit_count: input.unitCount,
    coverage_gaps: input.coverageGaps ?? 0,
    input_tokens: input.input,
    input_counted: optionalCounted(input.input),
    cached_tokens: input.cached ?? null,
    cached_counted: optionalCounted(input.cached),
    uncached_tokens: input.uncached ?? null,
    uncached_counted: optionalCounted(input.uncached),
    cache_write_tokens: input.cacheWrite ?? null,
    cache_write_counted: optionalCounted(input.cacheWrite),
    output_tokens: input.output ?? null,
    output_counted: optionalCounted(input.output),
    reasoning_tokens: input.reasoning ?? null,
    reasoning_counted: optionalCounted(input.reasoning),
  };
}

function usageRow(
  base: Omit<UsageBreakdownRow, "is_partial" | "partial_columns">,
  partialColumns: Array<UsageTokenColumn> = [],
): UsageBreakdownRow {
  return {
    ...base,
    is_partial: partialColumns.length > 0,
    partial_columns: partialColumns,
  };
}

function dailyRow(
  date: string,
  source: string,
  accountingBasis: string,
  values: CounterInput,
  partialColumns: Array<UsageTokenColumn> = [],
): DailyUsageRow {
  return {
    source,
    accounting_basis: accountingBasis,
    unit_kind: "request",
    date,
    ...counters(values),
    is_partial: partialColumns.length > 0,
    partial_columns: partialColumns,
  };
}

function delta(
  windowDays: 7 | 30,
  netDelta: number | null,
  reportedUsageDelta: number | null,
  coverage: BalanceWindowDelta["coverage"],
  coverageReason: BalanceWindowDelta["coverage_reason"],
  baselineSampledAt: string | null,
  actualIntervalSeconds: number | null,
  historyComplete: boolean,
): BalanceWindowDelta {
  return {
    window_days: windowDays,
    net_delta: netDelta,
    reported_usage_delta: reportedUsageDelta,
    reported_usage_delta_discontinuity: false,
    baseline_sampled_at: baselineSampledAt,
    actual_interval_seconds: actualIntervalSeconds,
    coverage,
    coverage_reason: coverageReason,
    history_complete: historyComplete,
  };
}

const PRODUCERS: Array<ProducerHealth> = [
  {
    producer_id: "pull-openrouter",
    display_name: "OpenRouter balance",
    mode: "pull",
    expected_interval_seconds: 1800,
    last_heartbeat_at: "2026-11-27T11:58:00Z",
    last_attempt_at: "2026-11-27T11:58:00Z",
    last_status: "ok",
    last_error: null,
    heartbeat_age_seconds: 120,
    is_stale: false,
  },
  {
    producer_id: "pull-deepseek",
    display_name: "DeepSeek balance",
    mode: "pull",
    expected_interval_seconds: 1800,
    last_heartbeat_at: "2026-11-27T09:50:00Z",
    last_attempt_at: "2026-11-27T09:50:00Z",
    last_status: "ok",
    last_error: null,
    heartbeat_age_seconds: 7800,
    is_stale: true,
  },
  {
    producer_id: "debitmetre-main",
    display_name: "debitmetre (Codex usage)",
    mode: "push",
    expected_interval_seconds: 3600,
    last_heartbeat_at: "2026-11-27T11:57:00Z",
    last_attempt_at: "2026-11-27T11:57:00Z",
    last_status: "ok",
    last_error: null,
    heartbeat_age_seconds: 180,
    is_stale: false,
  },
  {
    producer_id: "orihsus-main",
    display_name: "orihsus (OpenCode Go)",
    mode: "push",
    expected_interval_seconds: 300,
    last_heartbeat_at: "2026-11-27T11:59:00Z",
    last_attempt_at: "2026-11-27T11:59:00Z",
    last_status: "ok",
    last_error: null,
    heartbeat_age_seconds: 60,
    is_stale: false,
  },
  {
    producer_id: "telemetre-main",
    display_name: "telemetre (quota history)",
    mode: "push",
    expected_interval_seconds: 600,
    last_heartbeat_at: "2026-11-27T11:40:00Z",
    last_attempt_at: "2026-11-27T11:40:00Z",
    last_status: "error",
    last_error: "telemetre request failed (HTTP 502)",
    heartbeat_age_seconds: 1200,
    is_stale: true,
  },
];

const BALANCES: Array<BalanceView> = [
  {
    producer_id: "pull-openrouter",
    provider: "openrouter",
    account: "primary",
    currency: "USD",
    sampled_at: "2026-11-27T11:58:00Z",
    ingested_at: "2026-11-27T11:58:30Z",
    total_balance: 137.42,
    topped_up_balance: null,
    granted_balance: null,
    cumulative_usage: 412.58,
    credit_limit: 200,
    is_available: null,
    data_age_seconds: 120,
    is_stale: false,
    deltas: [
      delta(7, -12.34, 28.9, "full", null, "2026-11-20T11:58:00Z", 7 * 86_400 + 120, true),
      delta(30, 37.42, 175.3, "full", null, "2026-10-28T11:58:00Z", 30 * 86_400 + 120, true),
    ],
  },
  {
    producer_id: "pull-deepseek",
    provider: "deepseek",
    account: "primary",
    currency: "CNY",
    sampled_at: "2026-11-27T09:50:00Z",
    ingested_at: "2026-11-27T09:50:30Z",
    total_balance: 83.5,
    topped_up_balance: 80,
    granted_balance: 3.5,
    cumulative_usage: null,
    credit_limit: null,
    is_available: true,
    data_age_seconds: 7800,
    is_stale: true,
    deltas: [
      delta(7, -16.5, null, "full", null, "2026-11-20T09:50:00Z", 7 * 86_400, true),
      delta(30, null, null, "unavailable", "missing_baseline", null, null, false),
    ],
  },
];

function windowView(
  slot: string,
  {
    bucketId = "key-fp-1",
    label = null,
    status = "ok",
    ...values
  }: Omit<QuotaWindow, "bucket_id" | "slot" | "label" | "status"> & {
    bucketId?: string;
    label?: string | null;
    status?: QuotaWindow["status"];
  },
): QuotaWindow {
  return {
    bucket_id: bucketId,
    slot,
    label,
    status,
    ...values,
  };
}

function observation(
  sampleId: string,
  sampledAt: string,
  sampleAgeSeconds: number | null,
  windows: Array<QuotaWindow>,
  options: Partial<QuotaObservation> = {},
): QuotaObservation {
  return {
    sample_id: sampleId,
    observer_machine: "gateway-a",
    sampled_at: sampledAt,
    interval_seconds: 300,
    sample_age_seconds: sampleAgeSeconds,
    is_stale: false,
    status: "ok",
    time_anomaly: null,
    error_summary: null,
    windows,
    ...options,
  };
}

function attempt(
  sampleId: string,
  sampledAt: string,
  sampleAgeSeconds: number | null,
  options: Partial<QuotaAttempt> = {},
): QuotaAttempt {
  return {
    sample_id: sampleId,
    observer_machine: "gateway-a",
    sampled_at: sampledAt,
    sample_age_seconds: sampleAgeSeconds,
    status: "ok",
    time_anomaly: null,
    error_summary: null,
    ...options,
  };
}

const QUOTA_SUBJECTS: Array<QuotaSubject> = [
  {
    source: "opencode",
    account: "key-fp-1",
    latest_valid: observation("key-fp-1-valid", "2026-11-27T11:55:00Z", 300, [
      windowView("rolling", {
        bucketId: "key-fp-1",
        label: "primary-key",
        used_percent: 42.5,
        remaining_percent: 57.5,
        resets_at: "2026-11-27T12:15:00Z",
        reset_in_seconds: 900,
        window_duration_mins: 300,
      }),
      windowView("weekly", {
        bucketId: "key-fp-1",
        label: "primary-key",
        used_percent: 10,
        remaining_percent: 90,
        resets_at: "2026-12-01T00:00:00Z",
        reset_in_seconds: 302_400,
        window_duration_mins: 10_080,
      }),
    ]),
    latest_attempt: attempt("key-fp-1-valid", "2026-11-27T11:55:00Z", 300),
    anomalies: [],
  },
  {
    source: "opencode",
    account: "key-fp-2",
    latest_valid: observation(
      "key-fp-2-valid",
      "2026-11-27T10:05:00Z",
      6900,
      [
        windowView("rolling", {
          bucketId: "key-fp-2",
          label: "secondary-key",
          used_percent: 95,
          remaining_percent: 5,
          resets_at: "2026-11-27T11:00:00Z",
          reset_in_seconds: 0,
          window_duration_mins: 300,
        }),
      ],
      { observer_machine: "gateway-b", is_stale: true },
    ),
    latest_attempt: attempt("key-fp-2-valid", "2026-11-27T10:05:00Z", 6900, {
      observer_machine: "gateway-b",
    }),
    anomalies: [],
  },
  {
    source: "opencode",
    account: "key-fp-3",
    latest_valid: null,
    latest_attempt: attempt("key-fp-3-error", "2026-11-27T11:57:00Z", 180, {
      status: "error",
      error_summary: "upstream_error",
    }),
    anomalies: [],
  },
  {
    source: "codex",
    account: "codex-main",
    latest_valid: observation(
      "codex-main-valid",
      "2026-11-27T11:58:00Z",
      120,
      [
        windowView("5h", {
          bucketId: "codex-5h",
          label: "primary",
          used_percent: 80,
          remaining_percent: 20,
          status: "limited",
          resets_at: "2026-11-27T12:10:00Z",
          reset_in_seconds: 600,
          window_duration_mins: 300,
        }),
      ],
      { observer_machine: "machine-a" },
    ),
    latest_attempt: attempt("codex-main-valid", "2026-11-27T11:58:00Z", 120, {
      observer_machine: "machine-a",
    }),
    anomalies: [],
  },
  {
    source: "agy",
    account: "agy-main",
    latest_valid: observation(
      "agy-main-valid",
      "2026-11-27T11:56:00Z",
      240,
      [
        windowView("five-hour", {
          bucketId: "Gemini",
          label: "5h",
          used_percent: 40,
          remaining_percent: 60,
          resets_at: "2026-11-27T16:00:00Z",
          reset_in_seconds: 14_400,
          window_duration_mins: 300,
        }),
        windowView("weekly", {
          bucketId: "Gemini",
          label: "7d",
          used_percent: 20,
          remaining_percent: 80,
          resets_at: "2026-12-03T00:00:00Z",
          reset_in_seconds: 432_000,
          window_duration_mins: 10_080,
        }),
      ],
      { observer_machine: "studio-a" },
    ),
    latest_attempt: attempt("agy-main-valid", "2026-11-27T11:56:00Z", 240, {
      observer_machine: "studio-a",
    }),
    anomalies: [
      attempt("agy-main-clock", "2026-11-27T13:05:00Z", null, {
        observer_machine: "studio-a",
        time_anomaly: "future_clock_skew",
      }),
    ],
  },
];

const MONTHLY_ROWS: Array<UsageBreakdownRow> = [
  usageRow({
    source: "codex",
    accounting_basis: "debitmetre-audit-v1",
    unit_kind: "request",
    actor_kind: "machine",
    actor_id: "machine-a",
    model: "gpt-5.1-codex",
    effort: "high",
    ...counters({
      unitCount: 96,
      input: 1_842_000,
      cached: 1_310_000,
      uncached: 532_000,
      cacheWrite: 0,
      output: 96_400,
      reasoning: 28_900,
    }),
  }),
  usageRow({
    source: "codex",
    accounting_basis: "debitmetre-audit-v1",
    unit_kind: "request",
    actor_kind: "machine",
    actor_id: "machine-a",
    model: "gpt-5.1-codex",
    effort: "low",
    ...counters({
      unitCount: 54,
      input: 512_000,
      cached: 338_000,
      uncached: 174_000,
      cacheWrite: 0,
      output: 37_800,
      reasoning: 8100,
    }),
  }),
  usageRow(
    {
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      actor_kind: "machine",
      actor_id: "machine-b",
      model: "gpt-5-mini",
      effort: "",
      ...counters({
        unitCount: 23,
        input: null,
        output: 18_400,
        coverageGaps: 2,
      }),
    },
    ["input_tokens", "cached_tokens", "uncached_tokens", "cache_write_tokens"],
  ),
  usageRow({
    source: "opencode",
    accounting_basis: "orihsus-audit-v1",
    unit_kind: "request",
    actor_kind: "identity",
    actor_id: "key-fp-1",
    model: "deepseek-v4",
    effort: "",
    ...counters({
      unitCount: 312,
      input: 2_640_000,
      cached: 1_950_000,
      uncached: 690_000,
      cacheWrite: 0,
      output: 214_000,
      reasoning: 61_000,
    }),
  }),
  usageRow({
    source: "opencode",
    accounting_basis: "orihsus-audit-v1",
    unit_kind: "request",
    actor_kind: "identity",
    actor_id: "key-fp-1",
    model: "deepseek-v4",
    effort: "low",
    ...counters({
      unitCount: 41,
      input: 286_000,
      cached: 201_000,
      uncached: 85_000,
      cacheWrite: 0,
      output: 22_700,
      reasoning: 4300,
    }),
  }),
  usageRow(
    {
      source: "opencode",
      accounting_basis: "orihsus-audit-v1",
      unit_kind: "request",
      actor_kind: "identity",
      actor_id: "key-fp-2",
      model: "qwen3.8-max",
      effort: "high",
      ...counters({
        unitCount: 87,
        input: 712_000,
        cached: null,
        uncached: 712_000,
        cacheWrite: null,
        output: 55_300,
        reasoning: 21_400,
      }),
    },
    ["cached_tokens", "cache_write_tokens"],
  ),
];

const DAILY_ROWS: Array<DailyUsageRow> = [
  dailyRow("2026-11-23", "codex", "debitmetre-audit-v1", {
    unitCount: 14,
    input: 184_000,
    cached: 121_000,
    uncached: 63_000,
    cacheWrite: 0,
    output: 12_600,
    reasoning: 3100,
  }),
  dailyRow("2026-11-24", "codex", "debitmetre-audit-v1", {
    unitCount: 22,
    input: 302_000,
    cached: 201_000,
    uncached: 101_000,
    cacheWrite: 0,
    output: 19_800,
    reasoning: 5400,
  }),
  dailyRow("2026-11-24", "opencode", "orihsus-audit-v1", {
    unitCount: 38,
    input: 418_000,
    cached: 290_000,
    uncached: 128_000,
    cacheWrite: 0,
    output: 31_500,
    reasoning: 8900,
  }),
  dailyRow("2026-11-25", "codex", "debitmetre-audit-v1", {
    unitCount: 19,
    input: 271_000,
    cached: 180_000,
    uncached: 91_000,
    cacheWrite: 0,
    output: 17_200,
    reasoning: 4700,
  }),
  dailyRow(
    "2026-11-25",
    "opencode",
    "orihsus-audit-v1",
    {
      unitCount: 44,
      input: 506_000,
      cached: null,
      uncached: 506_000,
      cacheWrite: null,
      output: 38_400,
      reasoning: 10_200,
      coverageGaps: 1,
    },
    ["cached_tokens", "cache_write_tokens"],
  ),
  dailyRow("2026-11-26", "codex", "debitmetre-audit-v1", {
    unitCount: 27,
    input: 368_000,
    cached: 249_000,
    uncached: 119_000,
    cacheWrite: 0,
    output: 24_100,
    reasoning: 6800,
  }),
  dailyRow("2026-11-26", "opencode", "orihsus-audit-v1", {
    unitCount: 56,
    input: 641_000,
    cached: 442_000,
    uncached: 199_000,
    cacheWrite: 0,
    output: 47_300,
    reasoning: 12_500,
  }),
  dailyRow("2026-11-27", "codex", "debitmetre-audit-v1", {
    unitCount: 11,
    input: 149_000,
    cached: 98_000,
    uncached: 51_000,
    cacheWrite: 0,
    output: 10_400,
    reasoning: 2900,
  }),
];

function monthlyUsage(timezone: string, month: string): MonthlyUsage {
  const hasRows = month === FIXTURE_MONTH;
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    latest_bucket_start: hasRows ? "2026-11-27T11:00:00Z" : null,
    data_age_seconds: hasRows ? 3600 : null,
    is_stale: false,
    source_freshness: hasRows
      ? [
          {
            source: "codex",
            latest_bucket_start: "2026-11-27T11:00:00Z",
            data_age_seconds: 3600,
            is_stale: false,
          },
          {
            source: "opencode",
            latest_bucket_start: "2026-11-27T10:00:00Z",
            data_age_seconds: 7200,
            is_stale: true,
          },
        ]
      : [],
    rows: hasRows ? MONTHLY_ROWS : [],
  };
}

export function buildPopulatedOverview(timezone: string, month: string): OverviewResponse {
  return {
    generated_at: NOW,
    producers: PRODUCERS,
    balances: BALANCES,
    usage: monthlyUsage(timezone, month),
    quotas: { generated_at: NOW, subjects: QUOTA_SUBJECTS },
  };
}

export function buildEmptyOverview(timezone: string, month: string): OverviewResponse {
  return {
    generated_at: NOW,
    producers: [],
    balances: [],
    usage: {
      timezone,
      month,
      bucket_attribution: "exact",
      bucket_attribution_note: null,
      latest_bucket_start: null,
      data_age_seconds: null,
      is_stale: false,
      source_freshness: [],
      rows: [],
    },
    quotas: { generated_at: NOW, subjects: [] },
  };
}

export function buildPopulatedDaily(timezone: string, month: string): UsageDailyResponse {
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    rows: month === FIXTURE_MONTH ? DAILY_ROWS : [],
  };
}

export function buildEmptyDaily(timezone: string, month: string): UsageDailyResponse {
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    rows: [],
  };
}

function historyPoints(
  start: string,
  stepDays: number,
  values: ReadonlyArray<number>,
): Array<BalanceHistoryPoint> {
  const startMs = Date.parse(start);
  return values.map((value, index) => {
    const sampledAt = isoAt(startMs + index * stepDays * DAY_MS);
    return {
      sampled_at: sampledAt,
      ingested_at: isoAt(Date.parse(sampledAt) + 60_000),
      total_balance: value,
      cumulative_usage: null,
    };
  });
}

export function buildPopulatedHistory(provider: BalanceProvider): BalanceHistoryResponse {
  if (provider === "openrouter") {
    return {
      provider,
      days: 30,
      series: [
        {
          account: "primary",
          currency: "USD",
          points: historyPoints(
            "2026-10-29T12:00:00Z",
            2,
            [
              152.1, 149.8, 145.2, 143.6, 151.4, 148.9, 144.3, 142.0, 139.6, 146.8, 144.1, 141.7,
              148.2, 140.5, 137.42,
            ],
          ),
        },
      ],
    };
  }

  return {
    provider,
    days: 30,
    series: [
      {
        account: "primary",
        currency: "CNY",
        points: historyPoints(
          "2026-10-30T09:50:00Z",
          3,
          [101.2, 98.4, 95.1, 93.8, 90.2, 88.7, 92.4, 89.1, 86.3, 83.5],
        ),
      },
    ],
  };
}

export function buildEmptyHistory(provider: BalanceProvider): BalanceHistoryResponse {
  return { provider, days: 30, series: [] };
}
