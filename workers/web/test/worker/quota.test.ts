import type { QuotaResponse } from "@bilan/shared";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import ingestWorker from "../../../ingest/src/index";
import type { Env as IngestEnv } from "../../../ingest/src/types";
import { app } from "../../src/worker/app";
import { getQuotaOverview } from "../../src/worker/quota";
import { clearDatabase, seedUsageBucket } from "./seed";

const NOW = new Date("2026-11-27T12:00:00Z");
const ORIHSUS_TOKEN = "test-orihsus-token";
const QUOTA_PRODUCERS_JSON = JSON.stringify({
  "orihsus-main": {
    token_sha256: "174b251f753833d225882771a1488413ea9170f1db266b60491772948b7bccdd",
    display_name: "orihsus (OpenCode Go)",
    expected_interval_seconds: 1800,
    scopes: [{ source: "opencode", kind: "quota_observations" }],
  },
});

interface SeedWindow {
  bucketId?: string;
  slot: string;
  label?: string | null;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  status?: "ok" | "limited" | "cooldown" | "unknown" | null;
  resetsAt?: string | null;
  windowDurationMins?: number | null;
}

async function seedObservation(input: {
  sampleId: string;
  source?: string;
  account?: string;
  observerMachine?: string;
  sampledAt: string;
  ingestedAt?: string;
  intervalSeconds?: number | null;
  status?: "ok" | "empty" | "error";
  timeAnomaly?: string | null;
  errorSummary?: string | null;
  producerId?: string;
  batchSeq?: number;
  windows?: Array<SeedWindow>;
}): Promise<void> {
  const source = input.source ?? "opencode";
  const account = input.account ?? "fp_a";
  const producerId = input.producerId ?? "orihsus-main";
  await env.DB.prepare(
    `INSERT INTO quota_observations (
      producer_id, sample_id, source, account, observer_machine, sampled_at,
      interval_seconds, status, time_anomaly, error_summary, ingested_at, batch_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      producerId,
      input.sampleId,
      source,
      account,
      input.observerMachine ?? "gateway-a",
      input.sampledAt,
      input.intervalSeconds === undefined ? 300 : input.intervalSeconds,
      input.status ?? "ok",
      input.timeAnomaly ?? null,
      input.errorSummary ?? null,
      input.ingestedAt ?? input.sampledAt,
      input.batchSeq ?? 1,
    )
    .run();

  for (const window of input.windows ?? []) {
    await env.DB.prepare(
      `INSERT INTO quota_windows (
        producer_id, sample_id, bucket_id, slot, label, used_percent,
        remaining_percent, status, resets_at, window_duration_mins, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        producerId,
        input.sampleId,
        window.bucketId ?? account,
        window.slot,
        window.label ?? null,
        window.usedPercent ?? null,
        window.remainingPercent ?? null,
        window.status ?? null,
        window.resetsAt ?? null,
        window.windowDurationMins ?? null,
        null,
      )
      .run();
  }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM quota_windows"),
    env.DB.prepare("DELETE FROM quota_observations"),
  ]);
  await clearDatabase();
});

describe("B3 quota read query", () => {
  it("returns the latest valid sample per key with age, reset countdown, and no vanished window", async () => {
    await seedObservation({
      sampleId: "fp_a-old",
      account: "fp_a",
      sampledAt: "2026-11-27T11:40:00Z",
      windows: [
        { slot: "rolling", usedPercent: 10, remainingPercent: 90 },
        { slot: "monthly", usedPercent: 30, remainingPercent: 70 },
      ],
    });
    await seedObservation({
      sampleId: "fp_a-new",
      account: "fp_a",
      sampledAt: "2026-11-27T11:55:00Z",
      windows: [
        {
          slot: "rolling",
          usedPercent: 40,
          remainingPercent: 60,
          resetsAt: "2026-11-27T12:15:00Z",
        },
        {
          slot: "weekly",
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: "2026-11-27T12:05:00Z",
        },
      ],
    });
    await seedObservation({
      sampleId: "fp_b-new",
      account: "fp_b",
      sampledAt: "2026-11-27T11:58:00Z",
      windows: [
        {
          slot: "rolling",
          usedPercent: 90,
          remainingPercent: 10,
          status: "limited",
          resetsAt: "2026-11-27T12:10:00Z",
        },
      ],
    });

    const body = await getQuotaOverview(env.DB, NOW);

    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.subjects.map((subject) => subject.account)).toEqual(["fp_a", "fp_b"]);

    const fpA = body.subjects.find((subject) => subject.account === "fp_a");
    const fpB = body.subjects.find((subject) => subject.account === "fp_b");
    expect(fpA?.latest_valid).toMatchObject({
      sample_id: "fp_a-new",
      sampled_at: "2026-11-27T11:55:00Z",
      sample_age_seconds: 300,
      is_stale: false,
      status: "ok",
    });
    expect(fpA?.latest_valid?.windows.map((window) => window.slot)).toEqual(["rolling", "weekly"]);
    expect(fpA?.latest_valid?.windows.find((window) => window.slot === "rolling")).toMatchObject({
      bucket_id: "fp_a",
      used_percent: 40,
      remaining_percent: 60,
      reset_in_seconds: 900,
      resets_at: "2026-11-27T12:15:00Z",
    });
    expect(fpA?.latest_valid?.windows.find((window) => window.slot === "weekly")).toMatchObject({
      reset_in_seconds: 300,
    });

    // fp_b is independently polled and must not be hidden by fp_a.
    expect(fpB?.latest_valid).toMatchObject({
      sample_id: "fp_b-new",
      sampled_at: "2026-11-27T11:58:00Z",
      sample_age_seconds: 120,
    });
    expect(fpB?.latest_valid?.windows[0]).toMatchObject({
      bucket_id: "fp_b",
      used_percent: 90,
      remaining_percent: 10,
      status: "limited",
      reset_in_seconds: 600,
    });
  });

  it("breaks same-second ties by ingested_at", async () => {
    await seedObservation({
      sampleId: "same-second-old",
      sampledAt: "2026-11-27T11:59:00Z",
      ingestedAt: "2026-11-27T12:00:00Z",
      windows: [{ slot: "rolling", usedPercent: 10, remainingPercent: 90 }],
    });
    await seedObservation({
      sampleId: "same-second-new",
      sampledAt: "2026-11-27T11:59:00Z",
      ingestedAt: "2026-11-27T12:00:01Z",
      windows: [{ slot: "rolling", usedPercent: 20, remainingPercent: 80 }],
    });

    const body = await getQuotaOverview(env.DB, NOW);
    const subject = body.subjects[0];

    expect(subject?.latest_valid?.sample_id).toBe("same-second-new");
    expect(subject?.latest_valid?.windows[0]?.used_percent).toBe(20);
    expect(subject?.latest_attempt?.sample_id).toBe("same-second-new");
  });

  it("keeps failed, empty, and anomalous attempts separate from valid windows", async () => {
    for (const account of ["fp_error", "fp_empty", "fp_anomaly"]) {
      await seedObservation({
        sampleId: `${account}-valid`,
        account,
        sampledAt: "2026-11-27T11:50:00Z",
        windows: [{ slot: "rolling", usedPercent: 30, remainingPercent: 70 }],
      });
    }

    await seedObservation({
      sampleId: "fp_error-failed",
      account: "fp_error",
      sampledAt: "2026-11-27T11:55:00Z",
      status: "error",
      errorSummary: "http_error",
    });
    await seedObservation({
      sampleId: "fp_empty-empty",
      account: "fp_empty",
      sampledAt: "2026-11-27T11:56:00Z",
      status: "empty",
    });
    await seedObservation({
      sampleId: "fp_anomaly-clock",
      account: "fp_anomaly",
      sampledAt: "2026-11-27T11:58:00Z",
      status: "ok",
      timeAnomaly: "clock_skew",
      windows: [{ slot: "rolling", usedPercent: 99, remainingPercent: 1 }],
    });

    const body = await getQuotaOverview(env.DB, NOW);
    const byAccount = new Map(body.subjects.map((subject) => [subject.account, subject]));

    const failed = byAccount.get("fp_error");
    expect(failed?.latest_valid).toMatchObject({
      sample_id: "fp_error-valid",
      status: "ok",
    });
    expect(failed?.latest_valid?.windows[0]?.used_percent).toBe(30);
    expect(failed?.latest_attempt).toMatchObject({
      sample_id: "fp_error-failed",
      status: "error",
      error_summary: "http_error",
    });
    expect(failed?.anomalies).toEqual([]);

    const empty = byAccount.get("fp_empty");
    expect(empty?.latest_valid).toMatchObject({ sample_id: "fp_empty-valid" });
    expect(empty?.latest_attempt).toMatchObject({
      sample_id: "fp_empty-empty",
      status: "empty",
    });

    const anomalous = byAccount.get("fp_anomaly");
    expect(anomalous?.latest_valid).toMatchObject({ sample_id: "fp_anomaly-valid" });
    expect(anomalous?.latest_valid?.windows[0]?.used_percent).toBe(30);
    expect(anomalous?.latest_attempt).toMatchObject({ sample_id: "fp_anomaly-valid" });
    expect(anomalous?.anomalies).toHaveLength(1);
    expect(anomalous?.anomalies[0]).toMatchObject({
      sample_id: "fp_anomaly-clock",
      status: "ok",
      time_anomaly: "clock_skew",
    });
  });

  it("returns no fabricated windows when only invalid attempts exist", async () => {
    await seedObservation({
      sampleId: "only-error",
      account: "fp_only_error",
      sampledAt: "2026-11-27T11:50:00Z",
      status: "error",
      errorSummary: "HTTP 503",
    });
    await seedObservation({
      sampleId: "only-anomaly",
      account: "fp_only_anomaly",
      sampledAt: "2026-11-27T11:55:00Z",
      status: "ok",
      timeAnomaly: "future_clock",
      windows: [{ slot: "rolling", usedPercent: 99, remainingPercent: 1 }],
    });

    const body = await getQuotaOverview(env.DB, NOW);
    const byAccount = new Map(body.subjects.map((subject) => [subject.account, subject]));

    const onlyError = byAccount.get("fp_only_error");
    expect(onlyError?.latest_valid).toBeNull();
    expect(onlyError?.latest_attempt).toMatchObject({ status: "error" });
    expect(onlyError?.anomalies).toEqual([]);

    const onlyAnomaly = byAccount.get("fp_only_anomaly");
    expect(onlyAnomaly?.latest_valid).toBeNull();
    expect(onlyAnomaly?.latest_attempt).toBeNull();
    expect(onlyAnomaly?.anomalies).toHaveLength(1);
    expect(onlyAnomaly?.anomalies[0]).toMatchObject({ time_anomaly: "future_clock" });
  });

  it("marks old valid samples stale using their configured interval", async () => {
    await seedObservation({
      sampleId: "stale",
      account: "fp_stale",
      sampledAt: "2026-11-27T10:00:00Z",
      intervalSeconds: 300,
      windows: [{ slot: "rolling", usedPercent: 10, remainingPercent: 90 }],
    });
    await seedObservation({
      sampleId: "fresh",
      account: "fp_fresh",
      sampledAt: "2026-11-27T11:58:00Z",
      intervalSeconds: 300,
      windows: [{ slot: "rolling", usedPercent: 10, remainingPercent: 90 }],
    });

    const body = await getQuotaOverview(env.DB, NOW);
    const byAccount = new Map(body.subjects.map((subject) => [subject.account, subject]));
    expect(byAccount.get("fp_stale")?.latest_valid?.is_stale).toBe(true);
    expect(byAccount.get("fp_fresh")?.latest_valid?.is_stale).toBe(false);
  });

  it("sanitizes arbitrary upstream error summaries before public return", async () => {
    const sentinel = "synthetic-secret-sentinel-must-never-return";
    const ctx = createExecutionContext();
    const ingestEnv: IngestEnv = {
      DB: env.DB,
      INGEST_PRODUCERS_JSON: QUOTA_PRODUCERS_JSON,
    };
    const response = await ingestWorker.fetch(
      new Request("https://bilan-ingest.example/api/v1/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ORIHSUS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: 1,
          batch_seq: 1,
          usage_buckets: [],
          quota_observations: [
            {
              sample_id: "opencode:fp_error:2026-11-26T14:30:00Z:error",
              source: "opencode",
              account: "fp_error",
              observer_machine: "gateway-a",
              sampled_at: "2026-11-26T14:30:00Z",
              interval_seconds: 300,
              status: "error",
              time_anomaly: null,
              error_summary: sentinel,
              windows: [],
            },
            {
              sample_id: "opencode:fp_empty:2026-11-26T14:31:00Z:empty",
              source: "opencode",
              account: "fp_empty",
              observer_machine: "gateway-a",
              sampled_at: "2026-11-26T14:31:00Z",
              interval_seconds: 300,
              status: "empty",
              time_anomaly: null,
              error_summary: sentinel,
              windows: [],
            },
          ],
          balance_snapshots: [],
        }),
      }),
      ingestEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status, await response.text()).toBe(200);

    const stored = await env.DB.prepare(
      "SELECT account, status, error_summary FROM quota_observations ORDER BY account",
    ).all<{ account: string; status: string; error_summary: string | null }>();
    expect(stored.results).toEqual([
      { account: "fp_empty", status: "empty", error_summary: null },
      { account: "fp_error", status: "error", error_summary: "upstream_error" },
    ]);
    expect(JSON.stringify(stored.results)).not.toContain(sentinel);

    const quotaResponse = await app.request("https://bilan-web.example/api/v1/quotas", {}, env);
    expect(quotaResponse.status).toBe(200);
    const quotaBody: QuotaResponse = await quotaResponse.json();
    expect(JSON.stringify(quotaBody)).not.toContain(sentinel);
    const byAccount = new Map(quotaBody.subjects.map((subject) => [subject.account, subject]));
    expect(byAccount.get("fp_error")?.latest_attempt).toMatchObject({
      status: "error",
      error_summary: "upstream_error",
    });
    expect(byAccount.get("fp_empty")?.latest_attempt).toMatchObject({
      status: "empty",
      error_summary: null,
    });

    const overviewResponse = await app.request(
      "https://bilan-web.example/api/v1/overview?tz=UTC&month=2026-11",
      {},
      env,
    );
    expect(overviewResponse.status).toBe(200);
    expect(await overviewResponse.text()).not.toContain(sentinel);
  });

  it("includes per-key quotas and both actor kinds in the normal overview", async () => {
    await seedUsageBucket({
      bucketStart: "2026-11-26T14:00:00Z",
      source: "codex",
      actorKind: "machine",
      actorId: "machine-a",
      model: "gpt-5",
      effort: "high",
      unitCount: 1,
      inputTokens: 10,
      inputCounted: 1,
      outputTokens: 5,
      outputCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-26T14:00:00Z",
      source: "opencode",
      actorKind: "identity",
      actorId: "laptop-key",
      model: "deepseek-chat",
      effort: "",
      unitCount: 2,
      inputTokens: 100,
      inputCounted: 2,
      cachedTokens: 40,
      cachedCounted: 2,
      uncachedTokens: 60,
      uncachedCounted: 2,
      cacheWriteTokens: null,
      cacheWriteCounted: 0,
      outputTokens: 20,
      outputCounted: 2,
      reasoningTokens: 4,
      reasoningCounted: 2,
      accountingBasis: "orihsus-audit-v1",
    });
    await seedObservation({
      sampleId: "overview-fp-a",
      sampledAt: "2026-11-26T14:30:00Z",
      windows: [{ slot: "rolling", usedPercent: 42.5, remainingPercent: 57.5 }],
    });

    const response = await app.request(
      "https://bilan-web.example/api/v1/overview?tz=UTC&month=2026-11",
      {},
      env,
    );

    expect(response.status).toBe(200);
    const body: {
      generated_at: string;
      usage: { rows: Array<{ source: string; actor_kind: string; actor_id: string }> };
      quotas: QuotaResponse;
    } = await response.json();

    expect(body.usage.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "codex",
          actor_kind: "machine",
          actor_id: "machine-a",
        }),
        expect.objectContaining({
          source: "opencode",
          actor_kind: "identity",
          actor_id: "laptop-key",
        }),
      ]),
    );
    expect(body.quotas.generated_at).toBe(body.generated_at);
    expect(body.quotas.subjects).toHaveLength(1);
    expect(body.quotas.subjects[0]).toMatchObject({
      source: "opencode",
      account: "fp_a",
      latest_valid: {
        sample_id: "overview-fp-a",
        windows: [
          {
            slot: "rolling",
            used_percent: 42.5,
            remaining_percent: 57.5,
          },
        ],
      },
    });
  });

  it("serves the quota endpoint without caching", async () => {
    await seedObservation({
      sampleId: "endpoint",
      sampledAt: new Date(Date.now() - 60_000).toISOString(),
      windows: [{ slot: "rolling", usedPercent: 12, remainingPercent: 88 }],
    });

    const response = await app.request("https://bilan-web.example/api/v1/quotas", {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: QuotaResponse = await response.json();
    expect(body.subjects).toHaveLength(1);
    expect(body.subjects[0]).toMatchObject({ source: "opencode", account: "fp_a" });
    expect(body.subjects[0]?.latest_valid?.windows[0]?.used_percent).toBe(12);
  });

  it("does not expose producer identity or unbounded metadata", async () => {
    await seedObservation({
      sampleId: "safe-surface",
      sampledAt: "2026-11-27T11:58:00Z",
      windows: [{ slot: "rolling", usedPercent: 12, remainingPercent: 88, label: "go-key-1" }],
    });

    const body = await getQuotaOverview(env.DB, NOW);
    const serialized = JSON.stringify(body);

    expect(serialized).toContain("fp_a");
    expect(serialized).toContain("go-key-1");
    expect(serialized).not.toContain("orihsus-main");
    expect(serialized).not.toContain("meta_json");
  });
});
