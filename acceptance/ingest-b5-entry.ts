/**
 * Test-only ingest entry for the B5 multi-host acceptance run.
 *
 * The real scheduled orchestration, producer liveness, failure isolation, and
 * D1 writes run unchanged. Only the two upstream adapter network calls are
 * redirected to the loopback mock server, which keeps the acceptance run free
 * of live OpenRouter/DeepSeek traffic and credentials.
 */

import worker from "../workers/ingest/src/index";
import { PullError, deepSeekAdapter, openRouterAdapter } from "../workers/ingest/src/pull/adapters";
import type { Env } from "../workers/ingest/src/types";

function mockBase(env: Env): string {
  if (!("B5_MOCK_UPSTREAM_URL" in env)) {
    throw new Error("B5_MOCK_UPSTREAM_URL is not configured");
  }
  const value = env.B5_MOCK_UPSTREAM_URL;
  if (typeof value !== "string" || !value) {
    throw new Error("B5_MOCK_UPSTREAM_URL is not a usable URL");
  }
  return value;
}

openRouterAdapter.pull = async (env, sampledAt) => {
  const response = await fetch(`${mockBase(env)}/openrouter/api/v1/credits`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ""}`,
    },
    redirect: "manual",
  });
  if (!response.ok) {
    throw new PullError(`OpenRouter request failed (HTTP ${response.status})`);
  }
  await response.json();
  return [
    {
      provider: "openrouter",
      account: "default",
      currency: "USD",
      sampled_at: sampledAt,
      total_balance: 37.5,
      topped_up_balance: null,
      granted_balance: null,
      cumulative_usage: 12.5,
      credit_limit: 50,
      is_available: null,
    },
  ];
};

deepSeekAdapter.pull = async (env, sampledAt) => {
  const response = await fetch(`${mockBase(env)}/deepseek/user/balance`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY ?? ""}`,
    },
    redirect: "manual",
  });
  if (!response.ok) {
    throw new PullError(`DeepSeek request failed (HTTP ${response.status})`);
  }
  await response.json();
  return [
    {
      provider: "deepseek",
      account: "default",
      currency: "CNY",
      sampled_at: sampledAt,
      total_balance: 83.5,
      topped_up_balance: 80,
      granted_balance: 3.5,
      cumulative_usage: null,
      credit_limit: null,
      is_available: true,
    },
    {
      provider: "deepseek",
      account: "default",
      currency: "USD",
      sampled_at: sampledAt,
      total_balance: 5,
      topped_up_balance: 5,
      granted_balance: 0,
      cumulative_usage: null,
      credit_limit: null,
      is_available: true,
    },
  ];
};

export default worker;
