import type { OverviewResponse, UsageDailyResponse, UsageRangeResponse } from "@bilan/shared";
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

async function range(query = ""): Promise<UsageRangeResponse> {
  const response = await app.request(
    `https://bilan-web.example/api/v1/usage/range${query}`,
    {},
    env,
  );
  expect(response.status).toBe(200);
  const body: UsageRangeResponse = await response.json();
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

  it("ignores zero-unit tombstones on the usage and freshness read surfaces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    await seedProducer({
      producerId: "orihsus-main",
      displayName: "orihsus (OpenCode Go)",
      heartbeatAt: "2026-11-27T12:00:00Z",
      mode: "push",
    });
    await seedUsageBucket({
      producerId: "orihsus-main",
      source: "opencode",
      actorKind: "identity",
      actorId: "laptop-key",
      model: "deepseek-chat",
      effort: "",
      unitCount: 2,
      inputTokens: 120,
      inputCounted: 2,
      accountingBasis: "orihsus-audit-v1",
      bucketStart: "2026-11-26T10:00:00Z",
    });
    await seedUsageBucket({
      producerId: "orihsus-main",
      source: "opencode",
      actorKind: "identity",
      actorId: "unknown",
      model: "unknown",
      effort: "",
      unitCount: 0,
      coverageGaps: 0,
      accountingBasis: "orihsus-audit-v1",
      bucketStart: "2026-11-27T10:00:00Z",
      batchSeq: 2,
    });

    const body = await overview("?tz=UTC&month=2026-11");

    expect(body.usage.rows).toHaveLength(1);
    expect(body.usage.rows[0]).toMatchObject({
      source: "opencode",
      actor_id: "laptop-key",
      unit_count: 2,
    });
    expect(body.usage.latest_bucket_start).toBe("2026-11-26T10:00:00Z");
    const openCodeFreshness = body.usage.source_freshness.find(
      (source) => source.source === "opencode",
    );
    expect(openCodeFreshness?.latest_bucket_start).toBe("2026-11-26T10:00:00Z");

    const dailyBody = await daily("?tz=UTC&month=2026-11");
    expect(dailyBody.rows).toHaveLength(1);
    expect(dailyBody.rows[0]).toMatchObject({
      source: "opencode",
      date: "2026-11-26",
      unit_count: 2,
    });
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

  it("reports per-source freshness so fresh Codex cannot hide stale OpenCode Go", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
      await seedUsageBucket({
        bucketStart: "2026-11-27T11:55:00Z",
        source: "codex",
        actorKind: "machine",
        actorId: "machine-a",
        unitCount: 1,
        inputTokens: 10,
        inputCounted: 1,
      });
      await seedUsageBucket({
        bucketStart: "2026-11-27T08:00:00Z",
        source: "opencode",
        actorKind: "identity",
        actorId: "laptop-key",
        accountingBasis: "orihsus-audit-v1",
        unitCount: 2,
        inputTokens: 100,
        inputCounted: 2,
      });

      const body = await overview("?tz=UTC&month=2026-11");

      expect(body.usage.rows.map((row) => row.source).sort()).toEqual(["codex", "opencode"]);
      const freshness = new Map(
        body.usage.source_freshness.map((source) => [source.source, source]),
      );
      expect(freshness.get("codex")).toMatchObject({
        latest_bucket_start: "2026-11-27T11:55:00Z",
        data_age_seconds: 300,
        is_stale: false,
      });
      expect(freshness.get("opencode")).toMatchObject({
        latest_bucket_start: "2026-11-27T08:00:00Z",
        data_age_seconds: 14_400,
        is_stale: true,
      });
      // The global header remains the max across sources, but freshness is
      // carried per source so stale OpenCode Go is not hidden by Codex.
      expect(body.usage.latest_bucket_start).toBe("2026-11-27T11:55:00Z");
    } finally {
      vi.useRealTimers();
    }
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

describe("GET /api/v1/usage/range", () => {
  it("returns an hour-bounded 24h range including the current partial hour across a month boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));

    // One hour before the inclusive start: outside the rolling window.
    await seedUsageBucket({
      bucketStart: "2026-11-30T00:00:00Z",
      actorId: "machine-outside",
      unitCount: 9,
      inputTokens: 900,
      inputCounted: 9,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-30T01:00:00Z",
      actorId: "machine-a",
      unitCount: 2,
      inputTokens: 100,
      inputCounted: 2,
      cachedTokens: 40,
      cachedCounted: 2,
      outputTokens: 20,
      outputCounted: 2,
    });
    // Current partial hour, included even though the bucket is not complete.
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "machine-b",
      unitCount: 1,
      inputTokens: 50,
      inputCounted: 1,
      cachedTokens: 10,
      cachedCounted: 1,
      outputTokens: 5,
      outputCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      source: "opencode",
      actorKind: "identity",
      actorId: "laptop-key",
      accountingBasis: "orihsus-audit-v1",
      unitCount: 3,
      inputTokens: 300,
      inputCounted: 3,
      cachedTokens: 150,
      cachedCounted: 3,
      outputTokens: 30,
      outputCounted: 3,
    });
    // The exclusive end boundary.
    await seedUsageBucket({
      bucketStart: "2026-12-01T01:00:00Z",
      actorId: "machine-future",
      unitCount: 7,
      inputTokens: 700,
      inputCounted: 7,
    });

    const body = await range("?tz=UTC&window=24h");

    expect(body).toMatchObject({
      timezone: "UTC",
      window: "24h",
      granularity: "hour",
      range_start: "2026-11-30T01:00:00Z",
      range_end: "2026-12-01T01:00:00Z",
      current_hour_start: "2026-12-01T00:00:00Z",
      bucket_attribution: "exact",
    });
    expect(body.series.map((series) => series.source).sort()).toEqual(["codex", "opencode"]);

    const codex = body.series.find((series) => series.source === "codex");
    expect(codex?.points.map((point) => point.start)).toEqual([
      "2026-11-30T01:00:00Z",
      "2026-12-01T00:00:00Z",
    ]);
    expect(codex?.points.map((point) => point.includes_current_hour)).toEqual([false, true]);
    expect(codex?.totals).toMatchObject({
      unit_count: 3,
      input_tokens: 150,
      input_counted: 3,
      cached_tokens: 50,
      cached_counted: 3,
      output_tokens: 25,
      is_partial: true,
    });
    expect(codex?.totals.cache_hit_rate).toBeCloseTo(1 / 3, 10);

    const openCode = body.series.find((series) => series.source === "opencode");
    expect(openCode?.totals).toMatchObject({
      unit_count: 3,
      input_tokens: 300,
      cached_tokens: 150,
      output_tokens: 30,
      is_partial: true,
    });
    expect(openCode?.totals.cache_hit_rate).toBeCloseTo(0.5, 10);
  });

  it("groups 7d into local daily points while keeping the hour-based boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));

    await seedUsageBucket({
      bucketStart: "2026-11-24T00:00:00Z",
      actorId: "machine-outside",
      unitCount: 9,
      inputTokens: 900,
      inputCounted: 9,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-24T01:00:00Z",
      actorId: "machine-a",
      unitCount: 2,
      inputTokens: 100,
      inputCounted: 2,
      cachedTokens: 50,
      cachedCounted: 2,
      outputTokens: 20,
      outputCounted: 2,
    });
    await seedUsageBucket({
      bucketStart: "2026-11-24T23:00:00Z",
      actorId: "machine-b",
      unitCount: 3,
      inputTokens: 300,
      inputCounted: 3,
      cachedTokens: 100,
      cachedCounted: 3,
      outputTokens: 30,
      outputCounted: 3,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "machine-c",
      unitCount: 1,
      inputTokens: 10,
      inputCounted: 1,
      cachedTokens: 0,
      cachedCounted: 1,
      outputTokens: 5,
      outputCounted: 1,
    });

    const body = await range("?tz=UTC&window=7d");

    expect(body.granularity).toBe("day");
    expect(body.range_start).toBe("2026-11-24T01:00:00Z");
    expect(body.range_end).toBe("2026-12-01T01:00:00Z");
    const codex = body.series[0];
    expect(codex?.points.map((point) => point.date)).toEqual(["2026-11-24", "2026-12-01"]);
    expect(codex?.points[0]).toMatchObject({
      start: "2026-11-24T01:00:00Z",
      unit_count: 5,
      input_tokens: 400,
      cached_tokens: 150,
      output_tokens: 50,
      includes_current_hour: false,
    });
    expect(codex?.points[0]?.cache_hit_rate).toBeCloseTo(0.375, 10);
    expect(codex?.points[1]).toMatchObject({
      date: "2026-12-01",
      unit_count: 1,
      includes_current_hour: true,
    });
    expect(codex?.points[1]?.cache_hit_rate).toBe(0);
  });

  it("weights cache rates and leaves missing, incompatible, and zero denominators unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));

    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "weighted-a",
      accountingBasis: "weighted-v1",
      unitCount: 1,
      inputTokens: 100,
      inputCounted: 1,
      cachedTokens: 80,
      cachedCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "weighted-b",
      accountingBasis: "weighted-v1",
      unitCount: 1,
      inputTokens: 300,
      inputCounted: 1,
      cachedTokens: 20,
      cachedCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "measured-zero",
      accountingBasis: "measured-zero-v1",
      unitCount: 1,
      inputTokens: 50,
      inputCounted: 1,
      cachedTokens: 0,
      cachedCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "zero-denominator",
      accountingBasis: "zero-denominator-v1",
      unitCount: 1,
      inputTokens: 0,
      inputCounted: 1,
      cachedTokens: 0,
      cachedCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "missing-cache",
      accountingBasis: "missing-cache-v1",
      unitCount: 1,
      inputTokens: 200,
      inputCounted: 1,
    });
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      actorId: "incompatible",
      accountingBasis: "incompatible-v1",
      unitCount: 3,
      inputTokens: 300,
      inputCounted: 3,
      cachedTokens: 100,
      cachedCounted: 1,
    });

    // Input and cache can each be measured on one of two different requests.
    await seedUsageBucket({
      bucketStart: "2026-12-01T00:00:00Z",
      accountingBasis: "unpaired-v1",
      unitCount: 2,
      coverageGaps: 2,
      inputTokens: 100,
      inputCounted: 1,
      cachedTokens: 50,
      cachedCounted: 1,
    });
    const body = await range("?tz=UTC&window=24h");
    const byBasis = new Map(body.series.map((series) => [series.accounting_basis, series.totals]));

    expect(byBasis.get("unpaired-v1")?.cache_hit_rate).toBeNull();
    const weighted = byBasis.get("weighted-v1");
    expect(weighted).toMatchObject({
      unit_count: 2,
      input_tokens: 400,
      cached_tokens: 100,
      input_counted: 2,
      cached_counted: 2,
      is_partial: true,
    });
    expect(weighted?.cache_hit_rate).toBeCloseTo(0.25, 10);

    expect(byBasis.get("measured-zero-v1")?.cache_hit_rate).toBe(0);
    expect(byBasis.get("zero-denominator-v1")?.cache_hit_rate).toBeNull();
    expect(byBasis.get("missing-cache-v1")).toMatchObject({
      cache_hit_rate: null,
      cached_tokens: null,
      cached_counted: 0,
      is_partial: true,
    });
    expect(byBasis.get("incompatible-v1")).toMatchObject({
      cache_hit_rate: null,
      cached_tokens: 100,
      cached_counted: 1,
      input_counted: 3,
      is_partial: true,
    });
  });

  it("rejects unknown windows and timezones", async () => {
    for (const query of ["?tz=UTC&window=90d", "?tz=Mars/Base&window=24h"]) {
      const response = await app.request(
        `https://bilan-web.example/api/v1/usage/range${query}`,
        {},
        env,
      );
      expect(response.status).toBe(400);
    }
  });
});
