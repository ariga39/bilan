import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { mockUpstream } from "./mock-upstream";
import type { UpstreamMock } from "./mock-upstream";

const NOW = new Date("2026-11-27T12:00:00Z");
const NOW_ISO = NOW.toISOString();

interface ProducerRow {
  producer_id: string;
  last_heartbeat_at: string | null;
  last_attempt_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
}

let upstream: UpstreamMock | null = null;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM balance_snapshots"),
    env.DB.prepare("DELETE FROM producers"),
  ]);
});

afterEach(() => {
  upstream?.restore();
  upstream = null;
});

function mockProviders(
  options: { deepSeekStatus?: number; deepSeekBody?: string } = {},
): UpstreamMock {
  upstream = mockUpstream((call) => {
    if (call.url === "https://openrouter.ai/api/v1/credits") {
      if (call.authorization !== "Bearer test-openrouter-key") {
        return { status: 401, body: { error: "unauthorized" } };
      }
      return {
        body: { data: { total_credits: 50, total_usage: 12.5 } },
      };
    }

    if (call.url === "https://api.deepseek.com/user/balance") {
      if (call.authorization !== "Bearer test-deepseek-key") {
        return { status: 401, body: { error: "unauthorized" } };
      }
      if (options.deepSeekStatus !== undefined) {
        return {
          status: options.deepSeekStatus,
          body: options.deepSeekBody ?? "",
        };
      }
      return {
        body: {
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "83.50",
              granted_balance: "3.50",
              topped_up_balance: "80.00",
            },
            {
              currency: "USD",
              total_balance: "5.00",
              granted_balance: "0.00",
              topped_up_balance: "5.00",
            },
          ],
        },
      };
    }

    return { status: 404, body: { error: "unexpected_url" } };
  });
  return upstream;
}

async function runScheduled(): Promise<void> {
  const controller = createScheduledController({
    scheduledTime: NOW,
    cron: "*/30 * * * *",
  });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

async function producers(): Promise<Array<ProducerRow>> {
  const result = await env.DB.prepare(
    `SELECT producer_id, last_heartbeat_at, last_attempt_at, last_status, last_error
     FROM producers ORDER BY producer_id`,
  ).all<ProducerRow>();
  return result.results;
}

describe("scheduled balance collection", () => {
  it("pulls both providers into D1 with their latest balances and fresh liveness", async () => {
    const calls = mockProviders();

    await runScheduled();

    expect(calls.calls).toHaveLength(2);
    expect(calls.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(calls.calls.map((call) => call.authorization)).toEqual([
      "Bearer test-openrouter-key",
      "Bearer test-deepseek-key",
    ]);

    const balances = await env.DB.prepare(
      `SELECT provider, currency, sampled_at, total_balance, cumulative_usage,
              credit_limit, topped_up_balance, granted_balance, is_available
       FROM balance_snapshots ORDER BY provider, currency`,
    ).all<{
      provider: string;
      currency: string;
      sampled_at: string;
      total_balance: number;
      cumulative_usage: number | null;
      credit_limit: number | null;
      topped_up_balance: number | null;
      granted_balance: number | null;
      is_available: number | null;
    }>();

    expect(balances.results).toEqual([
      {
        provider: "deepseek",
        currency: "CNY",
        sampled_at: NOW_ISO,
        total_balance: 83.5,
        cumulative_usage: null,
        credit_limit: null,
        topped_up_balance: 80,
        granted_balance: 3.5,
        is_available: 1,
      },
      {
        provider: "deepseek",
        currency: "USD",
        sampled_at: NOW_ISO,
        total_balance: 5,
        cumulative_usage: null,
        credit_limit: null,
        topped_up_balance: 5,
        granted_balance: 0,
        is_available: 1,
      },
      {
        provider: "openrouter",
        currency: "USD",
        sampled_at: NOW_ISO,
        total_balance: 37.5,
        cumulative_usage: 12.5,
        credit_limit: 50,
        topped_up_balance: null,
        granted_balance: null,
        is_available: null,
      },
    ]);

    expect(await producers()).toEqual([
      {
        producer_id: "pull-deepseek",
        last_heartbeat_at: NOW_ISO,
        last_attempt_at: NOW_ISO,
        last_status: "ok",
        last_error: null,
      },
      {
        producer_id: "pull-openrouter",
        last_heartbeat_at: NOW_ISO,
        last_attempt_at: NOW_ISO,
        last_status: "ok",
        last_error: null,
      },
    ]);
  });

  it("isolates a DeepSeek failure while OpenRouter commits, without leaking upstream details", async () => {
    mockProviders({
      deepSeekStatus: 500,
      deepSeekBody: "upstream-secret=super-secret-response-body",
    });

    await runScheduled();

    const openRouter = await env.DB.prepare(
      `SELECT provider, total_balance FROM balance_snapshots WHERE provider = 'openrouter'`,
    ).all<{ provider: string; total_balance: number }>();
    const deepSeek = await env.DB.prepare(
      `SELECT provider FROM balance_snapshots WHERE provider = 'deepseek'`,
    ).all<{ provider: string }>();

    expect(openRouter.results).toEqual([{ provider: "openrouter", total_balance: 37.5 }]);
    expect(deepSeek.results).toEqual([]);

    const rows = await producers();
    const deepSeekProducer = rows.find((row) => row.producer_id === "pull-deepseek");
    const openRouterProducer = rows.find((row) => row.producer_id === "pull-openrouter");

    expect(openRouterProducer).toMatchObject({
      last_status: "ok",
      last_error: null,
      last_heartbeat_at: NOW_ISO,
    });
    expect(deepSeekProducer).toMatchObject({
      last_status: "error",
      last_attempt_at: NOW_ISO,
      last_heartbeat_at: null,
    });
    expect(deepSeekProducer?.last_error).toBe("DeepSeek request failed (HTTP 500)");
    expect(deepSeekProducer?.last_error).not.toContain("super-secret");
    expect(deepSeekProducer?.last_error).not.toContain("test-deepseek-key");
  });

  it("treats an upstream redirect as a failure instead of following it", async () => {
    const calls = mockUpstream((call) => {
      if (call.url.startsWith("https://openrouter.ai/")) {
        return { status: 302 };
      }
      return {
        body: {
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "83.50",
              granted_balance: "3.50",
              topped_up_balance: "80.00",
            },
          ],
        },
      };
    });

    await runScheduled();

    expect(calls.calls.every((call) => call.redirect === "error")).toBe(true);
    const openRouterRows = await env.DB.prepare(
      `SELECT provider FROM balance_snapshots WHERE provider = 'openrouter'`,
    ).all<{ provider: string }>();
    expect(openRouterRows.results).toEqual([]);

    const openRouterProducer = (await producers()).find(
      (row) => row.producer_id === "pull-openrouter",
    );
    expect(openRouterProducer).toMatchObject({
      last_status: "error",
      last_error: "OpenRouter request failed (HTTP 302)",
    });
  });

  it("exposes no read or UI routes", async () => {
    const ctx = createExecutionContext();

    for (const path of ["/", "/api/v1/overview", "/api/v1/balances/history"]) {
      const response = await worker.fetch(
        new Request(`https://bilan-ingest.example${path}`),
        env,
        ctx,
      );
      expect(response.status).toBe(404);
    }

    await waitOnExecutionContext(ctx);
  });
});
