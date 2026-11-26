import type { OverviewResponse } from "@bilan/shared";
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ingestWorker from "../../../ingest/src/index";
import type { Env as IngestEnv } from "../../../ingest/src/types";
import { app } from "../../src/worker/app";
import { mockUpstream } from "./mock-upstream";
import type { UpstreamMock } from "./mock-upstream";
import { clearDatabase } from "./seed";

let upstream: UpstreamMock | null = null;

beforeEach(async () => {
  await clearDatabase();
});

afterEach(() => {
  upstream?.restore();
  upstream = null;
});

function mockProviders(deepSeek: { status: number; body: unknown }): UpstreamMock {
  upstream = mockUpstream((call) => {
    if (call.url === "https://openrouter.ai/api/v1/credits") {
      return {
        body: { data: { total_credits: 50, total_usage: 12.5 } },
      };
    }
    if (call.url === "https://api.deepseek.com/user/balance") {
      return { status: deepSeek.status, body: deepSeek.body };
    }
    return { status: 404, body: { error: "unexpected_url" } };
  });
  return upstream;
}

async function runScheduledPulls(): Promise<void> {
  const controller = createScheduledController({
    scheduledTime: new Date(),
    cron: "*/30 * * * *",
  });
  const ctx = createExecutionContext();
  const ingestEnv: IngestEnv = {
    DB: env.DB,
    OPENROUTER_API_KEY: "test-openrouter-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
  };

  await ingestWorker.scheduled(controller, ingestEnv, ctx);
  await waitOnExecutionContext(ctx);
}

async function overview(): Promise<OverviewResponse> {
  const response = await app.request("https://bilan-web.example/api/v1/overview", {}, env);
  expect(response.status).toBe(200);
  const body: OverviewResponse = await response.json();
  return body;
}

const DEEPSEEK_SUCCESS = {
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
};

describe("ingest to read integration", () => {
  it("writes scheduled pulls into the shared D1 database that the read API serves", async () => {
    const calls = mockProviders({ status: 200, body: DEEPSEEK_SUCCESS });

    await runScheduledPulls();
    const body = await overview();

    expect(calls.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(body.balances).toHaveLength(3);
    expect(body.producers).toHaveLength(2);
    expect(
      body.producers.every(
        (producer) => producer.last_status === "ok" && producer.last_error === null,
      ),
    ).toBe(true);

    expect(body.balances.find((balance) => balance.provider === "openrouter")?.total_balance).toBe(
      37.5,
    );
    expect(
      body.balances.find((balance) => balance.provider === "deepseek" && balance.currency === "CNY")
        ?.total_balance,
    ).toBe(83.5);
    expect(
      body.balances.find((balance) => balance.provider === "deepseek" && balance.currency === "USD")
        ?.total_balance,
    ).toBe(5);
  });

  it("keeps the successful provider visible when the other provider fails", async () => {
    mockProviders({
      status: 500,
      body: "upstream-secret=super-secret-response-body",
    });

    await runScheduledPulls();
    const body = await overview();

    expect(body.balances.map((balance) => balance.provider)).toEqual(["openrouter"]);
    const openRouter = body.producers.find(
      (producer) => producer.producer_id === "pull-openrouter",
    );
    const deepSeek = body.producers.find((producer) => producer.producer_id === "pull-deepseek");

    expect(openRouter).toMatchObject({ last_status: "ok" });
    expect(deepSeek).toMatchObject({
      last_status: "error",
      last_error: "DeepSeek request failed (HTTP 500)",
    });
    expect(JSON.stringify(deepSeek)).not.toContain("super-secret");
    expect(JSON.stringify(deepSeek)).not.toContain("test-deepseek-key");
  });
});
