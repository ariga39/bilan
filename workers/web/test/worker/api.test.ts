import type { BalanceHistoryResponse, OverviewResponse } from "@bilan/shared";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../../src/worker/app";
import { clearDatabase, seedBalance, seedProducer } from "./seed";

const DAY_MS = 86_400_000;

async function overview(): Promise<OverviewResponse> {
  const response = await app.request("https://bilan-web.example/api/v1/overview", {}, env);
  expect(response.status).toBe(200);
  const body: OverviewResponse = await response.json();
  return body;
}

async function history(query: string): Promise<{ status: number; body: BalanceHistoryResponse }> {
  const response = await app.request(
    `https://bilan-web.example/api/v1/balances/history${query}`,
    {},
    env,
  );
  const body: BalanceHistoryResponse = await response.json();
  return {
    status: response.status,
    body,
  };
}

beforeEach(async () => {
  await clearDatabase();
});

describe("GET /api/v1/overview", () => {
  it("returns latest balances per provider and currency with isolated delta windows", async () => {
    const now = Date.now();
    const iso = (daysAgo: number, minutesAgo = 0): string =>
      new Date(now - daysAgo * DAY_MS - minutesAgo * 60_000).toISOString();

    await seedProducer({
      producerId: "pull-openrouter",
      displayName: "OpenRouter balance",
      heartbeatAt: iso(0, 1),
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: iso(31),
      totalBalance: 40,
      cumulativeUsage: 2,
      creditLimit: 42,
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: iso(8),
      totalBalance: 30,
      cumulativeUsage: 5,
      creditLimit: 42,
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: iso(0, 1),
      totalBalance: 37.5,
      cumulativeUsage: 12.5,
      creditLimit: 50,
      isAvailable: true,
    });

    await seedBalance({
      provider: "deepseek",
      currency: "CNY",
      sampledAt: iso(8),
      totalBalance: 100,
    });
    await seedBalance({
      provider: "deepseek",
      currency: "CNY",
      sampledAt: iso(0, 1),
      totalBalance: 83.5,
      toppedUpBalance: 80,
      grantedBalance: 3.5,
      isAvailable: true,
    });
    await seedBalance({
      provider: "deepseek",
      currency: "USD",
      sampledAt: iso(0, 1),
      totalBalance: 5,
      toppedUpBalance: 5,
      grantedBalance: 0,
      isAvailable: true,
    });

    const body = await overview();

    expect(body.balances).toHaveLength(3);
    expect(body.producers).toHaveLength(1);
    expect(body.producers[0]).toMatchObject({
      producer_id: "pull-openrouter",
      last_status: "ok",
      is_stale: false,
    });

    const openRouter = body.balances.find((balance) => balance.provider === "openrouter");
    const deepSeekCny = body.balances.find(
      (balance) => balance.provider === "deepseek" && balance.currency === "CNY",
    );
    const deepSeekUsd = body.balances.find(
      (balance) => balance.provider === "deepseek" && balance.currency === "USD",
    );

    expect(openRouter).toBeDefined();
    expect(deepSeekCny).toBeDefined();
    expect(deepSeekUsd).toBeDefined();

    expect(openRouter?.total_balance).toBe(37.5);
    expect(openRouter?.currency).toBe("USD");
    expect(openRouter?.data_age_seconds).toBeGreaterThanOrEqual(60);
    expect(openRouter?.data_age_seconds).toBeLessThan(180);

    const openRouter7d = openRouter?.deltas.find((delta) => delta.window_days === 7);
    const openRouter30d = openRouter?.deltas.find((delta) => delta.window_days === 30);

    expect(openRouter7d).toMatchObject({
      net_delta: 7.5,
      reported_usage_delta: 7.5,
      reported_usage_delta_discontinuity: false,
      history_complete: true,
    });
    expect(openRouter30d).toMatchObject({
      net_delta: -2.5,
      reported_usage_delta: 10.5,
      history_complete: true,
    });

    const cny7d = deepSeekCny?.deltas.find((delta) => delta.window_days === 7);
    const cny30d = deepSeekCny?.deltas.find((delta) => delta.window_days === 30);

    expect(cny7d).toMatchObject({
      net_delta: -16.5,
      reported_usage_delta: null,
      history_complete: true,
    });
    expect(cny30d).toMatchObject({
      net_delta: null,
      baseline_sampled_at: null,
      history_complete: false,
    });

    expect(deepSeekUsd?.deltas).toEqual([
      {
        window_days: 7,
        net_delta: null,
        reported_usage_delta: null,
        reported_usage_delta_discontinuity: false,
        baseline_sampled_at: null,
        history_complete: false,
      },
      {
        window_days: 30,
        net_delta: null,
        reported_usage_delta: null,
        reported_usage_delta_discontinuity: false,
        baseline_sampled_at: null,
        history_complete: false,
      },
    ]);

    expect(JSON.stringify(body)).not.toMatch(/spend|burn/iu);
  });

  it("surfaces a failed collector without hiding the other provider's balance", async () => {
    const now = new Date().toISOString();
    await seedProducer({
      producerId: "pull-openrouter",
      displayName: "OpenRouter balance",
      heartbeatAt: now,
    });
    await seedProducer({
      producerId: "pull-deepseek",
      displayName: "DeepSeek balance",
      heartbeatAt: now,
      status: "error",
      error: "DeepSeek request failed (HTTP 500)",
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: now,
      totalBalance: 37.5,
      cumulativeUsage: 12.5,
    });

    const body = await overview();

    expect(body.balances).toHaveLength(1);
    expect(body.balances[0]?.provider).toBe("openrouter");
    const deepSeek = body.producers.find((producer) => producer.producer_id === "pull-deepseek");
    expect(deepSeek).toMatchObject({
      last_status: "error",
      last_error: "DeepSeek request failed (HTTP 500)",
    });
  });
});

describe("GET /api/v1/balances/history", () => {
  it("groups points by account and currency and excludes points outside the window", async () => {
    const now = Date.now();
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: new Date(now - 40 * DAY_MS).toISOString(),
      totalBalance: 50,
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: new Date(now - 2 * DAY_MS).toISOString(),
      totalBalance: 42,
    });
    await seedBalance({
      provider: "openrouter",
      currency: "USD",
      sampledAt: new Date(now - 60 * 60_000).toISOString(),
      totalBalance: 37.5,
    });

    const result = await history("?provider=openrouter&days=30");

    expect(result.status).toBe(200);
    expect(result.body.provider).toBe("openrouter");
    expect(result.body.days).toBe(30);
    expect(result.body.series).toHaveLength(1);
    expect(result.body.series[0]?.currency).toBe("USD");
    expect(result.body.series[0]?.points.map((point) => point.total_balance)).toEqual([42, 37.5]);
  });

  it("validates provider and day inputs instead of querying arbitrary data", async () => {
    expect((await history("?provider=other&days=30")).status).toBe(400);
    expect((await history("?provider=openrouter&days=0")).status).toBe(400);
    expect((await history("?provider=openrouter&days=abc")).status).toBe(400);
    expect((await history("?provider=deepseek&days=30")).body.series).toEqual([]);
  });
});

describe("read surface", () => {
  it("has no write or ingest routes", async () => {
    const requests: Array<[string, string]> = [
      ["POST", "/api/v1/overview"],
      ["POST", "/api/v1/ingest"],
      ["GET", "/api/v1/ingest"],
      ["PUT", "/api/v1/balances/history?provider=openrouter"],
      ["GET", "/api/v1/unknown"],
    ];

    for (const [method, path] of requests) {
      const response = await app.request(`https://bilan-web.example${path}`, { method }, env);
      expect(response.status).toBe(404);
    }
  });
});
