import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { UsageBucketInput } from "../src/validate";

const ENDPOINT = "https://bilan-ingest.example/api/v1/ingest";
const DEBITMETRE_TOKEN = "test-debitmetre-token";
const OTHER_TOKEN = "test-other-token";

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

function bucket(overrides: Partial<UsageBucketInput> = {}): UsageBucketInput {
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

function envelope(sequence: number, buckets: Array<UsageBucketInput>) {
  return {
    schema_version: 1,
    batch_seq: sequence,
    usage_buckets: buckets,
    quota_observations: [],
    balance_snapshots: [],
  };
}

type TestIngestBody = {
  status?: "ok" | "duplicate";
  batch_seq?: number;
  error?: string;
};

async function post(
  payload: unknown,
  token: string | null = DEBITMETRE_TOKEN,
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

async function usageRows() {
  const result = await env.DB.prepare(
    `SELECT producer_id, source, actor_id, model, effort, bucket_start,
            unit_count, coverage_gaps, input_tokens, output_tokens, batch_seq
     FROM usage_buckets
     ORDER BY actor_id, model, effort`,
  ).all<{
    producer_id: string;
    source: string;
    actor_id: string;
    model: string;
    effort: string;
    bucket_start: string;
    unit_count: number;
    coverage_gaps: number;
    input_tokens: number | null;
    output_tokens: number | null;
    batch_seq: number;
  }>();
  return result.results;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM quota_windows"),
    env.DB.prepare("DELETE FROM quota_observations"),
    env.DB.prepare("DELETE FROM usage_buckets"),
    env.DB.prepare("DELETE FROM producers"),
  ]);
});

describe("POST /api/v1/ingest", () => {
  it("commits a scoped usage batch atomically with producer liveness", async () => {
    const result = await post({
      ...envelope(1, [bucket()]),
      producer_id: "pull-openrouter",
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "ok", batch_seq: 1 });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      producer_id: "debitmetre-main",
      source: "codex",
      actor_id: "machine-a",
      model: "gpt-5",
      effort: "high",
      bucket_start: "2026-11-01T00:00:00Z",
      unit_count: 2,
      input_tokens: 100,
      output_tokens: 20,
      batch_seq: 1,
    });

    const producer = (await producers())[0];
    expect(producer).toMatchObject({
      producer_id: "debitmetre-main",
      mode: "push",
      display_name: "debitmetre (Codex usage)",
      expected_interval_seconds: 3600,
      last_batch_seq: 1,
      last_status: "ok",
      last_error: null,
    });
    expect(JSON.parse(producer?.scopes_json ?? "[]")).toEqual([
      { source: "codex", kind: "usage_buckets" },
    ]);
    expect(producer?.last_heartbeat_at).not.toBeNull();
  });

  it("treats an equal batch_seq as a no-op ACK without rewriting rows or heartbeat", async () => {
    await post(envelope(1, [bucket()]));
    await env.DB.prepare("UPDATE producers SET last_heartbeat_at = '2026-11-01T00:00:00Z'").run();

    const duplicate = await post(
      envelope(1, [
        bucket({
          actor_id: "machine-b",
          unit_count: 99,
          input_tokens: 999,
        }),
      ]),
    );

    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate", batch_seq: 1 });
    expect(await usageRows()).toEqual([
      {
        producer_id: "debitmetre-main",
        source: "codex",
        actor_id: "machine-a",
        model: "gpt-5",
        effort: "high",
        bucket_start: "2026-11-01T00:00:00Z",
        unit_count: 2,
        coverage_gaps: 0,
        input_tokens: 100,
        output_tokens: 20,
        batch_seq: 1,
      },
    ]);
    const producer = (await producers())[0];
    expect(producer).toMatchObject({
      last_batch_seq: 1,
      last_heartbeat_at: "2026-11-01T00:00:00Z",
    });
  });

  it("returns 409 for a stale batch_seq with zero writes", async () => {
    await post(envelope(2, [bucket()]));

    const stale = await post(
      envelope(1, [
        bucket({
          actor_id: "machine-stale",
          bucket_start: "2026-11-01T01:00:00Z",
        }),
      ]),
    );

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale_batch" });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe("machine-a");
    expect((await producers())[0]?.last_batch_seq).toBe(2);
  });

  it("applies a higher-seq UTC-hour correction to the existing bucket", async () => {
    await post(envelope(1, [bucket()]));
    const correction = await post(
      envelope(2, [
        bucket({
          unit_count: 3,
          input_tokens: 150,
          input_counted: 3,
          output_tokens: 30,
          output_counted: 3,
        }),
      ]),
    );

    expect(correction.status).toBe(200);
    expect(correction.body).toMatchObject({ status: "ok", batch_seq: 2 });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unit_count: 3,
      input_tokens: 150,
      output_tokens: 30,
      batch_seq: 2,
    });
  });

  it("updates only liveness for an empty heartbeat, not the latest usage hour", async () => {
    await post(envelope(1, [bucket()]));
    const before = await env.DB.prepare(
      "SELECT MAX(bucket_start) AS latest, COUNT(*) AS rows FROM usage_buckets",
    ).first<{ latest: string | null; rows: number }>();
    await env.DB.prepare("UPDATE producers SET last_heartbeat_at = '2026-11-01T00:00:00Z'").run();

    const heartbeat = await post(envelope(2, []));

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toMatchObject({ status: "ok", batch_seq: 2 });
    const after = await env.DB.prepare(
      "SELECT MAX(bucket_start) AS latest, COUNT(*) AS rows FROM usage_buckets",
    ).first<{ latest: string | null; rows: number }>();
    expect(after).toEqual(before);
    const producer = (await producers())[0];
    expect(producer?.last_batch_seq).toBe(2);
    expect(producer?.last_heartbeat_at).not.toBe("2026-11-01T00:00:00Z");
  });

  it("rejects missing, unknown, and out-of-scope credentials without writes", async () => {
    expect((await post(envelope(1, [bucket()]), null)).status).toBe(401);
    expect((await post(envelope(1, [bucket()]), "not-a-token")).status).toBe(401);

    const wrongSource = await post(envelope(1, [bucket({ source: "opencode" })]), DEBITMETRE_TOKEN);
    expect(wrongSource.status).toBe(403);
    expect(wrongSource.body).toMatchObject({ error: "forbidden_scope" });

    const wrongKind = await post(
      {
        ...envelope(1, []),
        quota_observations: [
          {
            sample_id: "codex:out-of-scope:2026-11-01T00:00:00Z",
            source: "codex",
            account: "default",
            observer_machine: "machine-a",
            sampled_at: "2026-11-01T00:00:00Z",
            interval_seconds: 300,
            status: "ok",
            windows: [],
          },
        ],
      },
      DEBITMETRE_TOKEN,
    );
    expect(wrongKind.status).toBe(403);
    expect(await usageRows()).toEqual([]);
    expect(await producers()).toEqual([]);

    expect((await post(envelope(1, [bucket({ source: "opencode" })]), OTHER_TOKEN)).status).toBe(
      200,
    );
  });

  it("rejects malformed rows, non-hour buckets, and oversized batches", async () => {
    const cases: Array<unknown> = [
      { ...envelope(0, [bucket()]) },
      envelope(1, [bucket({ unit_count: -1 })]),
      envelope(1, [bucket({ input_counted: 3 })]),
      envelope(1, [bucket({ bucket_start: "2026-11-01T00:30:00Z" })]),
      { ...envelope(1, [bucket()]), schema_version: 2 },
      envelope(
        1,
        Array.from({ length: 501 }, (_, index) =>
          bucket({
            bucket_start: `2026-11-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
          }),
        ),
      ),
    ];

    for (const payload of cases) {
      const result = await post(payload);
      expect(result.status).toBe(400);
    }
    expect(await usageRows()).toEqual([]);
    expect(await producers()).toEqual([]);
  });

  it("lets only one competing request with the same batch_seq commit", async () => {
    const first = envelope(1, [bucket({ actor_id: "machine-a" })]);
    const second = envelope(1, [
      bucket({ actor_id: "machine-b", bucket_start: "2026-11-01T02:00:00Z" }),
    ]);

    const [left, right] = await Promise.all([post(first), post(second)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    const statuses = [left.body.status, right.body.status].sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
    expect(statuses).toEqual(["duplicate", "ok"]);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(["machine-a", "machine-b"]).toContain(rows[0]?.actor_id);
    expect((await producers())[0]?.last_batch_seq).toBe(1);
  });
});
