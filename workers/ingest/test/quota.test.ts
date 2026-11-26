import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { QuotaObservationInput, QuotaWindowInput, UsageBucketInput } from "../src/validate";

const ENDPOINT = "https://bilan-ingest.example/api/v1/ingest";
const ORIHSUS_TOKEN = "test-orihsus-token";
const TELEMETRE_TOKEN = "test-telemetre-token";
const DEBITMETRE_TOKEN = "test-debitmetre-token";

interface ProducerRow {
  producer_id: string;
  mode: string;
  display_name: string;
  scopes_json: string;
  expected_interval_seconds: number;
  last_batch_seq: number;
  last_heartbeat_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

interface ObservationRow {
  producer_id: string;
  sample_id: string;
  source: string;
  account: string;
  observer_machine: string;
  sampled_at: string;
  interval_seconds: number | null;
  status: string;
  time_anomaly: string | null;
  error_summary: string | null;
  ingested_at: string;
  batch_seq: number;
}

interface WindowRow {
  producer_id: string;
  sample_id: string;
  bucket_id: string;
  slot: string;
  label: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  status: string | null;
  resets_at: string | null;
  window_duration_mins: number | null;
  meta_json: string | null;
}

function quotaWindow(
  slot: string,
  used: number,
  overrides: Partial<QuotaWindowInput> = {},
): QuotaWindowInput {
  return {
    bucket_id: "fp_a",
    slot,
    label: null,
    used_percent: used,
    remaining_percent: 100 - used,
    status: "ok",
    resets_at: "2026-11-27T00:00:00Z",
    window_duration_mins: null,
    meta_json: null,
    ...overrides,
  };
}

function quotaObservation(overrides: Partial<QuotaObservationInput> = {}): QuotaObservationInput {
  return {
    sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:sample-a",
    source: "opencode",
    account: "fp_a",
    observer_machine: "gateway-a",
    sampled_at: "2026-11-26T14:30:00Z",
    interval_seconds: 300,
    status: "ok",
    time_anomaly: null,
    error_summary: null,
    windows: [quotaWindow("rolling", 10), quotaWindow("weekly", 20), quotaWindow("monthly", 30)],
    ...overrides,
  };
}

function usageBucket(overrides: Partial<UsageBucketInput> = {}): UsageBucketInput {
  return {
    source: "opencode",
    account: "default",
    actor_kind: "identity",
    actor_id: "laptop-key",
    model: "deepseek-chat",
    effort: "",
    bucket_start: "2026-11-26T14:00:00Z",
    unit_kind: "request",
    unit_count: 2,
    coverage_gaps: 0,
    input_tokens: 100,
    input_counted: 2,
    cached_tokens: 40,
    cached_counted: 2,
    uncached_tokens: 60,
    uncached_counted: 2,
    cache_write_tokens: null,
    cache_write_counted: 0,
    output_tokens: 20,
    output_counted: 2,
    reasoning_tokens: null,
    reasoning_counted: 0,
    accounting_basis: "orihsus-audit-v1",
    source_version: "1",
    ...overrides,
  };
}

interface EnvelopeOptions {
  buckets?: Array<UsageBucketInput>;
  observations?: Array<QuotaObservationInput>;
  balances?: Array<unknown>;
}

function envelope(sequence: number, options: EnvelopeOptions = {}) {
  return {
    schema_version: 1,
    batch_seq: sequence,
    usage_buckets: options.buckets ?? [],
    quota_observations: options.observations ?? [],
    balance_snapshots: options.balances ?? [],
  };
}

/** Build a deliberately invalid quota envelope without contextual typing. */
function rawEnvelope(sequence: number, observations: Array<unknown>) {
  return { ...envelope(sequence), quota_observations: observations };
}

type TestIngestBody = {
  status?: "ok" | "duplicate";
  batch_seq?: number;
  rows?: number;
  error?: string;
};

async function post(
  payload: unknown,
  token: string | null = ORIHSUS_TOKEN,
): Promise<{ status: number; body: TestIngestBody }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await app.request(
    ENDPOINT,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
    env,
  );
  const body: TestIngestBody = await response.json();
  return { status: response.status, body };
}

async function producers(): Promise<Array<ProducerRow>> {
  const result = await env.DB.prepare(
    `SELECT producer_id, mode, display_name, scopes_json, expected_interval_seconds,
            last_batch_seq, last_heartbeat_at, last_attempt_at, last_status, last_error
     FROM producers ORDER BY producer_id`,
  ).all<ProducerRow>();
  return result.results;
}

async function observations(): Promise<Array<ObservationRow>> {
  const result = await env.DB.prepare(
    `SELECT producer_id, sample_id, source, account, observer_machine, sampled_at,
            interval_seconds, status, time_anomaly, error_summary, ingested_at, batch_seq
     FROM quota_observations
     ORDER BY account, sampled_at, sample_id`,
  ).all<ObservationRow>();
  return result.results;
}

async function windows(): Promise<Array<WindowRow>> {
  const result = await env.DB.prepare(
    `SELECT producer_id, sample_id, bucket_id, slot, label, used_percent,
            remaining_percent, status, resets_at, window_duration_mins, meta_json
     FROM quota_windows
     ORDER BY sample_id, bucket_id, slot`,
  ).all<WindowRow>();
  return result.results;
}

async function usageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM usage_buckets").first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM quota_windows"),
    env.DB.prepare("DELETE FROM quota_observations"),
    env.DB.prepare("DELETE FROM usage_buckets"),
    env.DB.prepare("DELETE FROM producers"),
  ]);
});

describe("POST /api/v1/ingest quota observations", () => {
  it("commits a scoped observation with all windows atomically with producer liveness", async () => {
    const observation = quotaObservation();
    const result = await post(envelope(1, { observations: [observation] }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "ok", batch_seq: 1, rows: 4 });

    const stored = await observations();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      producer_id: "orihsus-main",
      sample_id: observation.sample_id,
      source: "opencode",
      account: "fp_a",
      observer_machine: "gateway-a",
      sampled_at: "2026-11-26T14:30:00Z",
      interval_seconds: 300,
      status: "ok",
      time_anomaly: null,
      error_summary: null,
      batch_seq: 1,
    });
    expect(stored[0]?.ingested_at).toBeTruthy();

    const storedWindows = await windows();
    expect(storedWindows).toHaveLength(3);
    const bySlot = new Map(storedWindows.map((row) => [row.slot, row]));
    expect(bySlot.get("rolling")).toMatchObject({
      producer_id: "orihsus-main",
      sample_id: observation.sample_id,
      bucket_id: "fp_a",
      label: null,
      used_percent: 10,
      remaining_percent: 90,
      status: "ok",
      resets_at: "2026-11-27T00:00:00Z",
      window_duration_mins: null,
      meta_json: null,
    });
    expect(bySlot.get("weekly")).toMatchObject({ used_percent: 20, remaining_percent: 80 });
    expect(bySlot.get("monthly")).toMatchObject({ used_percent: 30, remaining_percent: 70 });

    const producer = (await producers())[0];
    expect(producer).toMatchObject({
      producer_id: "orihsus-main",
      mode: "push",
      display_name: "orihsus (OpenCode Go)",
      expected_interval_seconds: 1800,
      last_batch_seq: 1,
      last_status: "ok",
      last_error: null,
    });
    expect(JSON.parse(producer?.scopes_json ?? "[]")).toEqual([
      { source: "opencode", kind: "usage_buckets" },
      { source: "opencode", kind: "quota_observations" },
    ]);
    expect(producer?.last_heartbeat_at).not.toBeNull();
  });

  it("treats an equal batch_seq as a no-op ACK for observations and children", async () => {
    await post(envelope(1, { observations: [quotaObservation()] }));
    await env.DB.prepare("UPDATE producers SET last_heartbeat_at = '2026-11-01T00:00:00Z'").run();

    const duplicate = await post(
      envelope(1, {
        observations: [
          quotaObservation({
            sample_id: "opencode:fp_b:2026-11-26T14:31:00Z:duplicate",
            account: "fp_b",
            sampled_at: "2026-11-26T14:31:00Z",
            windows: [quotaWindow("rolling", 50, { bucket_id: "fp_b" })],
          }),
        ],
      }),
    );

    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate", batch_seq: 1 });
    expect(await observations()).toHaveLength(1);
    expect(await windows()).toHaveLength(3);
    expect((await producers())[0]).toMatchObject({
      last_batch_seq: 1,
      last_heartbeat_at: "2026-11-01T00:00:00Z",
    });
  });

  it("returns 409 for a stale batch_seq with zero quota or usage writes", async () => {
    await post(envelope(2, { observations: [quotaObservation()] }));

    const stale = await post(
      envelope(1, {
        buckets: [usageBucket()],
        observations: [
          quotaObservation({
            sample_id: "opencode:fp_a:2026-11-26T15:00:00Z:stale",
            sampled_at: "2026-11-26T15:00:00Z",
          }),
        ],
      }),
    );

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale_batch" });
    expect(await observations()).toHaveLength(1);
    expect(await windows()).toHaveLength(3);
    expect(await usageCount()).toBe(0);
    expect((await producers())[0]?.last_batch_seq).toBe(2);
  });

  it("lets only one competing quota request with the same batch_seq commit", async () => {
    const first = envelope(1, {
      observations: [
        quotaObservation({
          sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:compete-a",
        }),
      ],
    });
    const second = envelope(1, {
      observations: [
        quotaObservation({
          sample_id: "opencode:fp_b:2026-11-26T14:31:00Z:compete-b",
          account: "fp_b",
          sampled_at: "2026-11-26T14:31:00Z",
          windows: [quotaWindow("rolling", 50, { bucket_id: "fp_b" })],
        }),
      ],
    });

    const [left, right] = await Promise.all([post(first), post(second)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    const statuses = [left.body.status, right.body.status].sort((a, b) =>
      String(a).localeCompare(String(b)),
    );
    expect(statuses).toEqual(["duplicate", "ok"]);
    expect(await observations()).toHaveLength(1);
    expect(await windows()).toHaveLength(3);
    expect((await producers())[0]?.last_batch_seq).toBe(1);
  });

  it("commits usage and quota rows in the same atomic batch", async () => {
    const result = await post(
      envelope(1, {
        buckets: [usageBucket()],
        observations: [quotaObservation()],
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "ok", batch_seq: 1, rows: 5 });
    expect(await usageCount()).toBe(1);
    expect(await observations()).toHaveLength(1);
    expect(await windows()).toHaveLength(3);
    expect((await producers())[0]?.last_batch_seq).toBe(1);
  });

  it("keeps same-second observations as distinct immutable samples", async () => {
    const first = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:same-second-a",
      windows: [quotaWindow("rolling", 10), quotaWindow("weekly", 20), quotaWindow("monthly", 30)],
    });
    const second = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:same-second-b",
      windows: [quotaWindow("rolling", 15), quotaWindow("weekly", 25), quotaWindow("monthly", 35)],
    });

    const result = await post(envelope(1, { observations: [first, second] }));

    expect(result.status).toBe(200);
    const stored = await observations();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((row) => row.sample_id))).toEqual(
      new Set([first.sample_id, second.sample_id]),
    );
    expect(new Set(stored.map((row) => row.sampled_at))).toEqual(new Set(["2026-11-26T14:30:00Z"]));
    const storedWindows = await windows();
    expect(
      storedWindows
        .filter((row) => row.slot === "rolling")
        .map((row) => row.used_percent)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([10, 15]);
  });

  it("stores independently polled keys without hiding one another", async () => {
    const fpA = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:key-a",
      account: "fp_a",
      sampled_at: "2026-11-26T14:30:00Z",
      windows: [quotaWindow("rolling", 10)],
    });
    const fpB = quotaObservation({
      sample_id: "opencode:fp_b:2026-11-26T14:31:00Z:key-b",
      account: "fp_b",
      sampled_at: "2026-11-26T14:31:00Z",
      windows: [quotaWindow("rolling", 100, { bucket_id: "fp_b", status: "limited" })],
    });

    const result = await post(envelope(1, { observations: [fpA, fpB] }));

    expect(result.status).toBe(200);
    const stored = await observations();
    expect(stored.map((row) => row.account).sort()).toEqual(["fp_a", "fp_b"]);

    const storedWindows = await windows();
    expect(storedWindows.find((row) => row.sample_id === fpA.sample_id)).toMatchObject({
      bucket_id: "fp_a",
      used_percent: 10,
    });
    expect(storedWindows.find((row) => row.sample_id === fpB.sample_id)).toMatchObject({
      bucket_id: "fp_b",
      used_percent: 100,
      status: "limited",
    });
  });

  it("does not carry a disappeared window into a newer observation", async () => {
    const older = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:with-monthly",
      sampled_at: "2026-11-26T14:30:00Z",
      windows: [quotaWindow("rolling", 10), quotaWindow("weekly", 20), quotaWindow("monthly", 30)],
    });
    const newer = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T15:30:00Z:without-monthly",
      sampled_at: "2026-11-26T15:30:00Z",
      windows: [quotaWindow("rolling", 11), quotaWindow("weekly", 21)],
    });

    await post(envelope(1, { observations: [older] }));
    await post(envelope(2, { observations: [newer] }));

    const latest = await env.DB.prepare(
      `SELECT sample_id FROM quota_observations
       WHERE source = 'opencode' AND account = 'fp_a'
       ORDER BY sampled_at DESC, ingested_at DESC LIMIT 1`,
    ).first<{ sample_id: string }>();
    expect(latest?.sample_id).toBe(newer.sample_id);

    const latestWindows = await env.DB.prepare(
      "SELECT slot FROM quota_windows WHERE sample_id = ? ORDER BY slot",
    )
      .bind(newer.sample_id)
      .all<{ slot: string }>();
    expect(latestWindows.results.map((row) => row.slot).sort()).toEqual(["rolling", "weekly"]);

    // The older immutable observation keeps its own monthly window.
    const olderWindows = await env.DB.prepare(
      "SELECT slot FROM quota_windows WHERE sample_id = ? ORDER BY slot",
    )
      .bind(older.sample_id)
      .all<{ slot: string }>();
    expect(olderWindows.results.map((row) => row.slot).sort()).toEqual([
      "monthly",
      "rolling",
      "weekly",
    ]);
  });

  it("never adds or replaces windows on an already stored sample_id", async () => {
    const original = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:stable",
      sampled_at: "2026-11-26T14:30:00Z",
      status: "ok",
      windows: [quotaWindow("rolling", 10), quotaWindow("weekly", 20)],
    });
    await post(envelope(1, { observations: [original] }));

    const repeated = quotaObservation({
      sample_id: original.sample_id,
      sampled_at: "2026-11-26T16:00:00Z",
      status: "empty",
      windows: [quotaWindow("rolling", 99), quotaWindow("weekly", 99), quotaWindow("monthly", 99)],
    });
    const result = await post(envelope(2, { observations: [repeated] }));

    expect(result.status).toBe(200);
    const stored = await observations();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      sample_id: original.sample_id,
      sampled_at: "2026-11-26T14:30:00Z",
      status: "ok",
      batch_seq: 1,
    });
    const storedWindows = await windows();
    expect(storedWindows.map((row) => row.slot).sort()).toEqual(["rolling", "weekly"]);
    expect((await producers())[0]?.last_batch_seq).toBe(2);
  });

  it("stores empty and failed observations explicitly without inventing readings", async () => {
    const empty = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:30:00Z:empty",
      status: "empty",
      windows: [],
    });
    const failed = quotaObservation({
      sample_id: "opencode:fp_a:2026-11-26T14:35:00Z:failed",
      sampled_at: "2026-11-26T14:35:00Z",
      status: "error",
      time_anomaly: "clock_skew",
      error_summary: "upstream HTTP 500",
      windows: [],
    });

    const result = await post(envelope(1, { observations: [empty, failed] }));

    expect(result.status).toBe(200);
    const stored = await observations();
    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.sample_id === empty.sample_id)).toMatchObject({
      status: "empty",
      time_anomaly: null,
      error_summary: null,
    });
    expect(stored.find((row) => row.sample_id === failed.sample_id)).toMatchObject({
      status: "error",
      time_anomaly: "clock_skew",
      error_summary: "upstream HTTP 500",
    });
    expect(await windows()).toEqual([]);
  });

  it("rejects quota pushes outside the producer's explicit scopes", async () => {
    const wrongKind = await post(
      envelope(1, { observations: [quotaObservation({ source: "codex" })] }),
      DEBITMETRE_TOKEN,
    );
    expect(wrongKind.status).toBe(403);
    expect(wrongKind.body).toMatchObject({ error: "forbidden_scope" });
    expect(await observations()).toEqual([]);
    expect(await producers()).toEqual([]);

    const wrongSource = await post(
      envelope(1, { observations: [quotaObservation({ source: "codex" })] }),
      ORIHSUS_TOKEN,
    );
    expect(wrongSource.status).toBe(403);

    const wrongUsage = await post(
      envelope(1, {
        buckets: [
          usageBucket({
            source: "codex",
            actor_kind: "machine",
            actor_id: "machine-a",
            accounting_basis: "debitmetre-audit-v1",
          }),
        ],
      }),
      TELEMETRE_TOKEN,
    );
    expect(wrongUsage.status).toBe(403);
    expect(await usageCount()).toBe(0);

    const balance = await post(
      envelope(1, { balances: [{ provider: "openrouter", currency: "USD" }] }),
      ORIHSUS_TOKEN,
    );
    expect(balance.status).toBe(403);
    expect(await observations()).toEqual([]);
    expect(await producers()).toEqual([]);
  });

  it("accepts per-source quota scopes without granting usage scopes", async () => {
    const result = await post(
      envelope(1, {
        observations: [
          quotaObservation({
            sample_id: "agy:agy-main:2026-11-26T14:30:00Z:five-hour",
            source: "agy",
            account: "agy-main",
            observer_machine: "machine-a",
            windows: [quotaWindow("5h", 10, { bucket_id: "agy-main" })],
          }),
          quotaObservation({
            sample_id: "codex:codex-main:2026-11-26T14:30:00Z:weekly",
            source: "codex",
            account: "codex-main",
            observer_machine: "machine-a",
            windows: [quotaWindow("weekly", 20, { bucket_id: "codex-main" })],
          }),
        ],
      }),
      TELEMETRE_TOKEN,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "ok", batch_seq: 1 });
    const stored = await observations();
    expect(stored.map((row) => row.source).sort()).toEqual(["agy", "codex"]);
    expect(await windows()).toHaveLength(2);

    const forbidden = await post(
      envelope(2, {
        buckets: [
          usageBucket({
            source: "codex",
            actor_kind: "machine",
            actor_id: "machine-a",
            accounting_basis: "debitmetre-audit-v1",
          }),
        ],
      }),
      TELEMETRE_TOKEN,
    );
    expect(forbidden.status).toBe(403);
    expect(await usageCount()).toBe(0);
    expect((await producers())[0]?.last_batch_seq).toBe(1);
  });

  it("accepts exactly 500 quota rows including observation windows", async () => {
    const full = Array.from({ length: 125 }, (_, index) =>
      quotaObservation({
        sample_id: `opencode:fp_a:2026-11-26T14:30:00Z:limit-${index}`,
      }),
    );

    const result = await post(envelope(1, { observations: full }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "ok", batch_seq: 1, rows: 500 });
    expect(await observations()).toHaveLength(125);
    expect(await windows()).toHaveLength(375);
  });

  it("rejects malformed, duplicate, and oversized quota payloads without writes", async () => {
    const base = quotaObservation();
    const malformed: Array<unknown> = [
      envelope(1, { observations: [{ ...base, sampled_at: "2026-11-26T14:30:00.000Z" }] }),
      envelope(1, { observations: [{ ...base, sampled_at: "2026-11-26T14:30:00+00:00" }] }),
      envelope(1, { observations: [{ ...base, sampled_at: "2026-02-30T14:30:00Z" }] }),
      rawEnvelope(1, [{ ...base, status: "partial" }]),
      envelope(1, { observations: [{ ...base, interval_seconds: 0 }] }),
      envelope(1, { observations: [{ ...base, windows: [quotaWindow("rolling", 101)] }] }),
      envelope(1, {
        observations: [
          {
            ...base,
            windows: [quotaWindow("rolling", 10, { remaining_percent: -0.01 })],
          },
        ],
      }),
      envelope(1, {
        observations: [
          { ...base, windows: [quotaWindow("rolling", 10, { resets_at: "not-a-date" })] },
        ],
      }),
      envelope(1, {
        observations: [{ ...base, windows: [quotaWindow("rolling", 10, { bucket_id: "" })] }],
      }),
      envelope(1, { observations: [base, { ...base }] }),
      envelope(1, {
        observations: [
          {
            ...base,
            windows: [quotaWindow("rolling", 10), quotaWindow("rolling", 20)],
          },
        ],
      }),
      envelope(1, {
        observations: Array.from({ length: 126 }, (_, index) =>
          quotaObservation({
            sample_id: `opencode:fp_a:2026-11-26T14:30:00Z:bulk-${index}`,
          }),
        ),
      }),
    ];

    for (const payload of malformed) {
      const result = await post(payload);
      expect(result.status).toBe(400);
    }

    expect(await observations()).toEqual([]);
    expect(await windows()).toEqual([]);
    expect(await usageCount()).toBe(0);
    expect(await producers()).toEqual([]);
  });
});
