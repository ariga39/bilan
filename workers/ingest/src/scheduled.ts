import type { BalanceSnapshotInput } from "@bilan/shared";

import { commitBalancePull, recordPullError } from "./db";
import { PullError, pullAdapters } from "./pull/adapters";
import type { PullAdapter } from "./pull/adapters";
import type { Env } from "./types";

function errorMessage(adapter: PullAdapter, error: unknown): string {
  if (error instanceof PullError) {
    return error.message;
  }
  return `${adapter.providerLabel} request failed`;
}

async function runAdapter(
  env: Env,
  adapter: PullAdapter,
  sampledAt: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  let snapshots: Array<BalanceSnapshotInput>;

  try {
    snapshots = await adapter.pull(env, sampledAt, fetchImpl);
  } catch (error) {
    await recordPullError(env, adapter, sampledAt, errorMessage(adapter, error));
    return;
  }

  try {
    await commitBalancePull(env, adapter, sampledAt, snapshots);
  } catch {
    await recordPullError(env, adapter, sampledAt, `${adapter.providerLabel} storage write failed`);
  }
}

export async function runScheduledPulls(
  controller: ScheduledController,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sampledAt = new Date(controller.scheduledTime).toISOString();
  const enabled = pullAdapters.filter((adapter) => adapter.isEnabled(env));

  await Promise.allSettled(
    enabled.map((adapter) => runAdapter(env, adapter, sampledAt, fetchImpl)),
  );
}
