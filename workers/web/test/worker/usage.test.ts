import type { OverviewResponse, UsageDailyResponse } from "@bilan/shared";
import { currentMonthInTimeZone } from "@bilan/shared";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../../src/worker/app";
import { clearDatabase, seedProducer, seedUsageBucket } from "./seed";

async function overview(query = ""): Promise<OverviewResponse> {
  const response = await app.request(`https://bilan-web.example/api/v1/overview${query}`, {}, env);
  expect(response.status).toBe(200);
  const body: OverviewResponse = await response.json();
  return body;
}

async function daily(query = ""): Promise<UsageDailyResponse> {
  const response = await app.request(
    `https://bilan-web.example/api/v1/usage/daily${query}`,
    {},
    env,
  );
  expect(response.status).toBe(200);
  const body: UsageDailyResponse = await response.json();
  return body;
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/overview usage", () => {
  it("slices the exact UTC+8 month and keeps machine, model, effort and partial counters distinct", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
    await seedProducer({
      producerId: "debitmetre-main",
      displayName: "debitmetre (Codex usage)",
      heartbeatAt: "2026-11-27T12:00:00Z",
      mode: "push",
      expectedIntervalSeconds: 3600,
    });

    // 2026-10-31 23:00 in UTC+8: outside November.
    await seedUsageBucket({
      bucketStart: "2026-10-31T15:00:00Z",
      unitCount: 4,
      inputTokens: 40,
      inputCounted: 4,
    });
    // 2026-11-01 00:00 in UTC+8: first November hour.
    await seedUsageBucket({
      bucketStart: "2026-10-31T16:00:00Z",
      actorId: "machine-a",
      model: "gpt-5",
      effort: "high",
      unitCount: 2,
      inputTokens: 100,
      inputCounted: 2,
      cachedTokens: 40,
      cachedCounted: 2,
      uncachedTokens: 60,
      uncachedCounted: 2,
      cacheWriteTokens: 0,
      cacheWriteCounted: 2,
      outputTokens: 20,
      outputCounted: 2,
      reasoningTokens: 5,
      reasoningCounted: 2,
    });
    // Same local month, unlabelled effort, input absent and one coverage gap.
    await seedUsageBucket({
      bucketStart: "2026-11-01T15:00:00Z",
      actorId: "machine-a",
      model: "gpt-5",
      effort: "",
      unitCount: 1,
      coverageGaps: 1,
      outputTokens: 7,
      outputCounted: 1,
    });
    // Same hour, different machine/model/effort, output only partially counted.
    await seedUsageBucket({
      bucketStart: "2026-11-01T16:00:00Z",
      actorId: "machine-b",
      model: "gpt-5-mini",
      effort: "low",
      unitCount: 3,
      inputTokens: 30,
      inputCounted: 3,
      outputTokens: 30,
      outputCounted: 2,
    });
    // 2026-12-01 00:00 in UTC+8: outside November.
    await seedUsageBucket({
      bucketStart: "2026-11-30T16:00:00Z",
      actorId: "machine-c",
      unitCount: 9,
      inputTokens: 900,
      inputCounted: 9,
    });
    // Latest globally, still outside the requested month.
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "machine-d",
      unitCount: 2,
      inputTokens: 200,
      inputCounted: 2,
    });

    const body = await overview("?tz=Asia/Shanghai&month=2026-11");

    expect(body.usage.timezone).toBe("Asia/Shanghai");
    expect(body.usage.month).toBe("2026-11");
    expect(body.usage.bucket_attribution).toBe("exact");
    expect(body.usage.bucket_attribution_note).toBeNull();
    expect(body.usage.latest_bucket_start).toBe("2026-12-01T00:00:00Z");
    expect(body.usage.rows).toHaveLength(3);

    const high = body.usage.rows.find(
      (row) => row.actor_id === "machine-a" && row.effort === "high",
    );
    expect(high).toMatchObject({
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_kind: "request",
      unit_count: 2,
      coverage_gaps: 0,
      input_tokens: 100,
      input_counted: 2,
      output_tokens: 20,
      output_counted: 2,
      is_partial: false,
      partial_columns: [],
    });

    const unlabelled = body.usage.rows.find((row) => row.effort === "");
    expect(unlabelled).toMatchObject({
      actor_id: "machine-a",
      unit_count: 1,
      coverage_gaps: 1,
      input_tokens: null,
      input_counted: 0,
      output_tokens: 7,
      output_counted: 1,
      is_partial: true,
    });
    expect(unlabelled?.partial_columns).toEqual(
      expect.arrayContaining(["input_tokens", "cached_tokens", "uncached_tokens"]),
    );

    const partial = body.usage.rows.find((row) => row.actor_id === "machine-b");
    expect(partial).toMatchObject({
      unit_count: 3,
      output_tokens: 30,
      output_counted: 2,
      is_partial: true,
    });
    expect(partial?.partial_columns).toContain("output_tokens");

    expect(body.usage.rows.some((row) => row.actor_id === "machine-c")).toBe(false);
    expect(body.usage.rows.some((row) => row.actor_id === "machine-d")).toBe(false);

    const producer = body.producers.find((row) => row.producer_id === "debitmetre-main");
    expect(producer).toMatchObject({ mode: "push", last_status: "ok" });
  });

  it("discloses approximate bucket-start attribution for non-whole-hour offsets", async () => {
    // Asia/Kolkata is UTC+05:30, so local November starts at 18:30Z.
    await seedUsageBucket({
      bucketStart: "2026-10-31T18:00:00Z", // 2026-10-31 23:30 local
      actorId: "machine-october",
    });
    await seedUsageBucket({
      bucketStart: "2026-10-31T19:00:00Z", // 2026-11-01 00:30 local
      actorId: "machine-november",
    });

    const body = await overview("?tz=Asia%2FKolkata&month=2026-11");
    expect(body.usage.bucket_attribution).toBe("approximate");
    expect(body.usage.bucket_attribution_note).toContain("Asia/Kolkata");
    expect(body.usage.bucket_attribution_note).toContain("bucket_start");
    expect(body.usage.rows.map((row) => row.actor_id)).toEqual(["machine-november"]);

    const dailyBody = await daily("?tz=Asia%2FKolkata&month=2026-11");
    expect(dailyBody.bucket_attribution).toBe("approximate");
    expect(dailyBody.bucket_attribution_note).toContain("Asia/Kolkata");
    expect(dailyBody.rows.map((row) => row.date)).toEqual(["2026-11-01"]);
  });

  it("defaults to Asia/Shanghai and the current month in that timezone", async () => {
    const body = await overview();
    expect(body.usage.timezone).toBe("Asia/Shanghai");
    expect(body.usage.month).toBe(currentMonthInTimeZone(new Date(), "Asia/Shanghai"));
  });

  it("excludes future buckets from data age and compares at second precision", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"));
      await seedUsageBucket({
        bucketStart: "2026-11-27T12:00:00Z",
        actorId: "machine-current",
        unitCount: 1,
        inputTokens: 10,
        inputCounted: 1,
      });
      await seedUsageBucket({
        bucketStart: "2026-12-01T00:00:00Z",
        actorId: "machine-future",
        unitCount: 9,
        inputTokens: 900,
        inputCounted: 9,
      });

      const body = await overview("?tz=UTC&month=2026-11");

      expect(body.usage.latest_bucket_start).toBe("2026-11-27T12:00:00Z");
      expect(body.usage.data_age_seconds).toBe(0);
      expect(body.usage.rows.some((row) => row.actor_id === "machine-future")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/v1/usage/daily", () => {
  it("aggregates by local calendar day without summing incompatible bases", async () => {
    await seedUsageBucket({
      bucketStart: "2026-11-01T15:00:00Z", // 2026-11-01 23:00 in UTC+8
      unitCount: 1,
      inputTokens: 10,
      inputCounted: 1,
      cachedTokens: 4,
      cachedCounted: 1,
      uncachedTokens: 6,
      uncachedCounted: 1,
      cacheWriteTokens: 0,
      cacheWriteCounted: 1,
      outputTokens: 5,
      outputCounted: 1,
      reasoningTokens: 1,
      reasoningCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-01T16:00:00Z", // 2026-11-02 00:00 in UTC+8
      unitCount: 2,
      inputTokens: 20,
      inputCounted: 2,
      outputTokens: 10,
      outputCounted: 2,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-01T17:00:00Z", // 2026-11-02 01:00, separate basis
      accountingBasis: "other-basis-v1",
      unitCount: 1,
      inputTokens: 7,
      inputCounted: 1,
      outputTokens: 3,
      outputCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-02T00:00:00Z", // 2026-11-02 08:00, partial output
      unitCount: 3,
      inputTokens: 30,
      inputCounted: 3,
      outputTokens: 15,
      outputCounted: 2,
    });

    const body = await daily("?tz=Asia/Shanghai&month=2026-11");

    expect(body.timezone).toBe("Asia/Shanghai");
    expect(body.month).toBe("2026-11");
    expect(body.bucket_attribution).toBe("exact");
    expect(body.bucket_attribution_note).toBeNull();
    expect(body.rows).toHaveLength(3);

    const firstDay = body.rows.find((row) => row.date === "2026-11-01");
    expect(firstDay).toMatchObject({
      source: "codex",
      accounting_basis: "debitmetre-audit-v1",
      unit_count: 1,
      input_tokens: 10,
      output_tokens: 5,
      is_partial: false,
    });

    const secondDay = body.rows.find(
      (row) => row.date === "2026-11-02" && row.accounting_basis === "debitmetre-audit-v1",
    );
    expect(secondDay).toMatchObject({
      unit_count: 5,
      input_tokens: 50,
      input_counted: 5,
      output_tokens: 25,
      output_counted: 4,
      is_partial: true,
    });
    expect(secondDay?.partial_columns).toContain("output_tokens");

    const otherBasis = body.rows.find(
      (row) => row.date === "2026-11-02" && row.accounting_basis === "other-basis-v1",
    );
    expect(otherBasis).toMatchObject({ unit_count: 1, input_tokens: 7, output_tokens: 3 });
  });

  it("rejects invalid timezone and month inputs", async () => {
    for (const query of ["?tz=Mars/Base&month=2026-11", "?tz=Asia/Shanghai&month=2026-13"]) {
      const overviewResponse = await app.request(
        `https://bilan-web.example/api/v1/overview${query}`,
        {},
        env,
      );
      const dailyResponse = await app.request(
        `https://bilan-web.example/api/v1/usage/daily${query}`,
        {},
        env,
      );
      expect(overviewResponse.status).toBe(400);
      expect(dailyResponse.status).toBe(400);
    }
  });
});
