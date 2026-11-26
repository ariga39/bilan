import type { BalanceSnapshotInput } from "@bilan/shared";

import type { Env } from "./types";
import type { PullAdapter } from "./pull/adapters";

export function sanitizeError(message: string): string {
  return message
    .replaceAll(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, 200);
}

const UPSERT_BALANCE = `INSERT INTO balance_snapshots (
  producer_id, provider, account, currency, sampled_at,
  total_balance, topped_up_balance, granted_balance, cumulative_usage,
  credit_limit, is_available, ingested_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(producer_id, provider, account, currency, sampled_at) DO UPDATE SET
  total_balance = excluded.total_balance,
  topped_up_balance = excluded.topped_up_balance,
  granted_balance = excluded.granted_balance,
  cumulative_usage = excluded.cumulative_usage,
  credit_limit = excluded.credit_limit,
  is_available = excluded.is_available,
  ingested_at = excluded.ingested_at`;

const UPSERT_PULL_SUCCESS = `INSERT INTO producers (
  producer_id, mode, display_name, scopes_json, expected_interval_seconds,
  last_heartbeat_at, last_attempt_at, last_status, last_error, updated_at
) VALUES (?, 'pull', ?, ?, ?, ?, ?, 'ok', NULL, ?)
ON CONFLICT(producer_id) DO UPDATE SET
  mode = 'pull',
  display_name = excluded.display_name,
  scopes_json = excluded.scopes_json,
  expected_interval_seconds = excluded.expected_interval_seconds,
  last_heartbeat_at = excluded.last_heartbeat_at,
  last_attempt_at = excluded.last_attempt_at,
  last_status = 'ok',
  last_error = NULL,
  updated_at = excluded.updated_at`;

const UPSERT_PULL_ERROR = `INSERT INTO producers (
  producer_id, mode, display_name, scopes_json, expected_interval_seconds,
  last_heartbeat_at, last_attempt_at, last_status, last_error, updated_at
) VALUES (?, 'pull', ?, ?, ?, NULL, ?, 'error', ?, ?)
ON CONFLICT(producer_id) DO UPDATE SET
  mode = 'pull',
  display_name = excluded.display_name,
  scopes_json = excluded.scopes_json,
  expected_interval_seconds = excluded.expected_interval_seconds,
  last_attempt_at = excluded.last_attempt_at,
  last_status = 'error',
  last_error = excluded.last_error,
  updated_at = excluded.updated_at`;

function scopesJson(adapter: PullAdapter): string {
  return JSON.stringify([{ source: adapter.provider, kind: "balance_snapshots" }]);
}

export async function commitBalancePull(
  env: Env,
  adapter: PullAdapter,
  sampledAt: string,
  snapshots: ReadonlyArray<BalanceSnapshotInput>,
): Promise<void> {
  const ingestedAt = new Date().toISOString();
  const statements = snapshots.map((snapshot) =>
    env.DB.prepare(UPSERT_BALANCE).bind(
      adapter.producerId,
      snapshot.provider,
      snapshot.account,
      snapshot.currency,
      snapshot.sampled_at,
      snapshot.total_balance,
      snapshot.topped_up_balance,
      snapshot.granted_balance,
      snapshot.cumulative_usage,
      snapshot.credit_limit,
      snapshot.is_available === null ? null : snapshot.is_available ? 1 : 0,
      ingestedAt,
    ),
  );

  statements.push(
    env.DB.prepare(UPSERT_PULL_SUCCESS).bind(
      adapter.producerId,
      adapter.displayName,
      scopesJson(adapter),
      adapter.expectedIntervalSeconds,
      sampledAt,
      sampledAt,
      ingestedAt,
    ),
  );

  await env.DB.batch(statements);
}

export async function recordPullError(
  env: Env,
  adapter: PullAdapter,
  sampledAt: string,
  message: string,
): Promise<void> {
  await env.DB.prepare(UPSERT_PULL_ERROR)
    .bind(
      adapter.producerId,
      adapter.displayName,
      scopesJson(adapter),
      adapter.expectedIntervalSeconds,
      sampledAt,
      sanitizeError(message),
      new Date().toISOString(),
    )
    .run();
}
