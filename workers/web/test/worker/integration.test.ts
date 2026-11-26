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
import type { UsageBucketInput } from "../../../ingest/src/validate";
import { app } from "../../src/worker/app";
import { mockUpstream } from "./mock-upstream";
import type { UpstreamMock } from "./mock-upstream";
import { clearDatabase } from "./seed";

const INGEST_TOKEN = "test-debitmetre-token";
const TELEMETRE_TOKEN = "test-telemetre-token";
const INGEST_PRODUCERS_JSON = JSON.stringify({
  "debitmetre-main": {
    token_sha256: "c6c726663d39185c46966f2075416a8b8348523b809c7e09f1ea984631e98a9b",
    display_name: "debitmetre (Codex usage)",
    expected_interval_seconds: 3600,
    scopes: [{ source: "codex", kind: "usage_buckets" }],
  },
  "telemetre-quota": {
    token_sha256: "da822ee843c11c977d04fa8914d6ddd33161258e734b46853aac031d2e63e403",
    display_name: "telemetre (AGY + Codex quota)",
    expected_interval_seconds: 1800,
    scopes: [
      { source: "agy", kind: "quota_observations" },
      { source: "codex", kind: "quota_observations" },
    ],
  },
});

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

async function usageOverview(): Promise<OverviewResponse> {
  const response = await app.request(
    "https://bilan-web.example/api/v1/overview?tz=Asia%2FShanghai&month=2026-11",
    {},
    env,
  );
  expect(response.status).toBe(200);
  const body: OverviewResponse = await response.json();
  return body;
}

async function push(payload: unknown, token: string = INGEST_TOKEN): Promise<void> {
  const ingestEnv: IngestEnv = {
    DB: env.DB,
    INGEST_PRODUCERS_JSON,
  };
  const ctx = createExecutionContext();
  const response = await ingestWorker.fetch(
    new Request("https://bilan-ingest.example/api/v1/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    ingestEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
}

function utcSecond(timestamp: number): string {
  return new Date(Math.floor(timestamp / 1000) * 1000).toISOString().replace(/\.000Z$/u, "Z");
}

function usageBucket(overrides: Partial<UsageBucketInput> = {}): UsageBucketInput {
  return {
    source: "codex",
    account: "default",
    actor_kind: "machine",
    actor_id: "machine-a",
    model: "gpt-5",
    effort: "high",
    bucket_start: "2026-11-01T00:00:00Z",
    unit_kind: "request",
    unit_count: 2,
    coverage_gaps: 0,
    input_tokens: 100,
    input_counted: 2,
    cached_tokens: 40,
    cached_counted: 2,
    uncached_tokens: 60,
    uncached_counted: 2,
    cache_write_tokens: 0,
    cache_write_counted: 2,
    output_tokens: 20,
    output_counted: 2,
    reasoning_tokens: 5,
    reasoning_counted: 2,
    accounting_basis: "debitmetre-audit-v1",
    source_version: "1",
    ...overrides,
  };
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

describe("push usage to read API integration", () => {
  it("serves pushed Codex buckets with UTC+8 month rows, then keeps data age stable across heartbeat and backfill", async () => {
    await push({
      schema_version: 1,
      batch_seq: 1,
      usage_buckets: [usageBucket()],
      quota_observations: [],
      balance_snapshots: [],
    });

    const first = await usageOverview();
    expect(first.usage.rows).toHaveLength(1);
    expect(first.usage.rows[0]).toMatchObject({
      actor_id: "machine-a",
      model: "gpt-5",
      effort: "high",
      unit_count: 2,
      input_tokens: 100,
      output_tokens: 20,
      is_partial: false,
    });
    expect(first.usage.latest_bucket_start).toBe("2026-11-01T00:00:00Z");

    await push({
      schema_version: 1,
      batch_seq: 2,
      usage_buckets: [],
      quota_observations: [],
      balance_snapshots: [],
    });
    const afterHeartbeat = await usageOverview();
    expect(afterHeartbeat.usage.latest_bucket_start).toBe("2026-11-01T00:00:00Z");
    expect(afterHeartbeat.usage.rows).toEqual(first.usage.rows);
    const producer = afterHeartbeat.producers.find((row) => row.producer_id === "debitmetre-main");
    expect(producer).toMatchObject({ last_status: "ok", mode: "push" });

    await push({
      schema_version: 1,
      batch_seq: 3,
      usage_buckets: [
        usageBucket({
          bucket_start: "2026-10-01T00:00:00Z",
          actor_id: "machine-old",
        }),
      ],
      quota_observations: [],
      balance_snapshots: [],
    });
    const afterBackfill = await usageOverview();
    expect(afterBackfill.usage.latest_bucket_start).toBe("2026-11-01T00:00:00Z");
    expect(afterBackfill.usage.rows).toHaveLength(1);
    expect(afterBackfill.usage.rows[0]?.actor_id).toBe("machine-a");
  });
});

describe("push quota to read API integration", () => {
  it("uses insertion order for same-batch, same-second quota ties", async () => {
    const sampledAt = utcSecond(Date.now() - 60_000);
    const observation = (sampleId: string, usedPercent: number) => ({
      sample_id: sampleId,
      source: "agy",
      account: "agy-same-batch",
      observer_machine: "studio-a",
      sampled_at: sampledAt,
      interval_seconds: 300,
      status: "ok",
      time_anomaly: null,
      error_summary: null,
      windows: [
        {
          bucket_id: "Gemini",
          slot: "five-hour",
          label: "5h",
          used_percent: usedPercent,
          remaining_percent: 100 - usedPercent,
          status: null,
          resets_at: null,
          window_duration_mins: 300,
          meta_json: null,
        },
      ],
    });

    // Both rows share sampled_at and the batch's ingested_at. The later row has
    // a lexicographically smaller id, so only insertion order (rowid) can make
    // it the latest valid sample and latest attempt.
    await push(
      {
        schema_version: 1,
        batch_seq: 1,
        usage_buckets: [],
        quota_observations: [observation("z-first", 10), observation("a-second", 20)],
        balance_snapshots: [],
      },
      TELEMETRE_TOKEN,
    );

    const body = await overview();
    const subject = body.quotas.subjects.find(
      (candidate) => candidate.source === "agy" && candidate.account === "agy-same-batch",
    );
    expect(subject?.latest_valid).toMatchObject({
      sample_id: "a-second",
      sampled_at: sampledAt,
    });
    expect(subject?.latest_valid?.windows[0]?.used_percent).toBe(20);
    expect(subject?.latest_attempt).toMatchObject({ sample_id: "a-second" });
  });
});
