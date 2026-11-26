import { env } from "cloudflare:test";

export async function clearDatabase(): Promise<void> {
  await env.DB.batch([
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
}): Promise<void> {
  const status = input.status ?? "ok";
  await env.DB.prepare(
    `INSERT INTO producers (
      producer_id, mode, display_name, scopes_json, expected_interval_seconds,
      last_heartbeat_at, last_attempt_at, last_status, last_error, updated_at
    ) VALUES (?, 'pull', ?, ?, 1800, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.producerId,
      input.displayName,
      JSON.stringify([{ source: "test", kind: "balance_snapshots" }]),
      input.heartbeatAt,
      input.heartbeatAt,
      status,
      input.error ?? null,
      input.heartbeatAt,
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
