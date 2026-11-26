import { env } from "cloudflare:test";

export async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM quota_windows"),
    env.DB.prepare("DELETE FROM quota_observations"),
    env.DB.prepare("DELETE FROM usage_buckets"),
    env.DB.prepare("DELETE FROM balance_snapshots"),
    env.DB.prepare("DELETE FROM producers"),
  ]);
}

export async function seedProducer(input: {
  producerId: string;
  displayName: string;
  heartbeatAt: string;
  status?: "ok" | "error";
  error?: string | null;
  mode?: "push" | "pull";
  expectedIntervalSeconds?: number;
}): Promise<void> {
  const status = input.status ?? "ok";
  const mode = input.mode ?? "pull";
  await env.DB.prepare(
    `INSERT INTO producers (
      producer_id, mode, display_name, scopes_json, expected_interval_seconds,
      last_heartbeat_at, last_attempt_at, last_status, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.producerId,
      mode,
      input.displayName,
      JSON.stringify([
        mode === "push"
          ? { source: "codex", kind: "usage_buckets" }
          : { source: "test", kind: "balance_snapshots" },
      ]),
      input.expectedIntervalSeconds ?? 1800,
      input.heartbeatAt,
      input.heartbeatAt,
      status,
      input.error ?? null,
      input.heartbeatAt,
    )
    .run();
}

export async function seedUsageBucket(input: {
  bucketStart: string;
  producerId?: string;
  source?: string;
  actorId?: string;
  actorKind?: "machine" | "identity";
  model?: string;
  effort?: string;
  unitKind?: string;
  unitCount?: number;
  coverageGaps?: number;
  inputTokens?: number | null;
  inputCounted?: number;
  cachedTokens?: number | null;
  cachedCounted?: number;
  uncachedTokens?: number | null;
  uncachedCounted?: number;
  cacheWriteTokens?: number | null;
  cacheWriteCounted?: number;
  outputTokens?: number | null;
  outputCounted?: number;
  reasoningTokens?: number | null;
  reasoningCounted?: number;
  accountingBasis?: string;
  batchSeq?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_buckets (
      producer_id, source, account, actor_kind, actor_id, model, effort, bucket_start,
      unit_kind, unit_count, coverage_gaps,
      input_tokens, input_counted, cached_tokens, cached_counted,
      uncached_tokens, uncached_counted, cache_write_tokens, cache_write_counted,
      output_tokens, output_counted, reasoning_tokens, reasoning_counted,
      accounting_basis, source_version, batch_seq, updated_at
    ) VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
  )
    .bind(
      input.producerId ?? "debitmetre-main",
      input.source ?? "codex",
      input.actorKind ?? "machine",
      input.actorId ?? "machine-a",
      input.model ?? "gpt-5",
      input.effort ?? "high",
      input.bucketStart,
      input.unitKind ?? "request",
      input.unitCount ?? 1,
      input.coverageGaps ?? 0,
      input.inputTokens ?? null,
      input.inputCounted ?? 0,
      input.cachedTokens ?? null,
      input.cachedCounted ?? 0,
      input.uncachedTokens ?? null,
      input.uncachedCounted ?? 0,
      input.cacheWriteTokens ?? null,
      input.cacheWriteCounted ?? 0,
      input.outputTokens ?? null,
      input.outputCounted ?? 0,
      input.reasoningTokens ?? null,
      input.reasoningCounted ?? 0,
      input.accountingBasis ?? "debitmetre-audit-v1",
      input.batchSeq ?? 1,
      input.bucketStart,
    )
    .run();
}

export async function seedBalance(input: {
  provider: "openrouter" | "deepseek";
  currency: string;
  sampledAt: string;
  totalBalance: number | null;
  cumulativeUsage?: number | null;
  toppedUpBalance?: number | null;
  grantedBalance?: number | null;
  creditLimit?: number | null;
  isAvailable?: boolean | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO balance_snapshots (
      producer_id, provider, account, currency, sampled_at,
      total_balance, topped_up_balance, granted_balance, cumulative_usage,
      credit_limit, is_available, ingested_at
    ) VALUES (?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.provider === "openrouter" ? "pull-openrouter" : "pull-deepseek",
      input.provider,
      input.currency,
      input.sampledAt,
      input.totalBalance,
      input.toppedUpBalance ?? null,
      input.grantedBalance ?? null,
      input.cumulativeUsage ?? null,
      input.creditLimit ?? null,
      input.isAvailable === null || input.isAvailable === undefined
        ? null
        : input.isAvailable
          ? 1
          : 0,
      input.sampledAt,
    )
    .run();
}
