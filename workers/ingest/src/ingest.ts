import type {
  IngestEnvelope,
  QuotaObservationInput,
  QuotaWindowInput,
  UsageBucketInput,
} from "./validate";
import { MAX_INGEST_BYTES, ingestRowCount, parseEnvelope } from "./validate";
import type { Env } from "./types";
import {
  IngestConfigError,
  bearerToken,
  parseProducerConfigs,
  resolveProducer,
  scopeAllows,
} from "./config";
import type { ProducerConfig } from "./config";

const INSERT_PRODUCER = `INSERT INTO producers (
  producer_id, mode, display_name, scopes_json, expected_interval_seconds,
  last_batch_seq, last_heartbeat_at, last_attempt_at, last_status, last_error, updated_at
) VALUES (?, 'push', ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?)
ON CONFLICT(producer_id) DO NOTHING`;

const UPSERT_USAGE = `INSERT INTO usage_buckets (
  producer_id, source, account, actor_kind, actor_id, model, effort, bucket_start,
  unit_kind, unit_count, coverage_gaps,
  input_tokens, input_counted, cached_tokens, cached_counted,
  uncached_tokens, uncached_counted, cache_write_tokens, cache_write_counted,
  output_tokens, output_counted, reasoning_tokens, reasoning_counted,
  accounting_basis, source_version, batch_seq, updated_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT last_batch_seq FROM producers WHERE producer_id = ?) < ?
ON CONFLICT(producer_id, source, account, actor_kind, actor_id, model, effort, bucket_start)
DO UPDATE SET
  unit_kind = excluded.unit_kind,
  unit_count = excluded.unit_count,
  coverage_gaps = excluded.coverage_gaps,
  input_tokens = excluded.input_tokens,
  input_counted = excluded.input_counted,
  cached_tokens = excluded.cached_tokens,
  cached_counted = excluded.cached_counted,
  uncached_tokens = excluded.uncached_tokens,
  uncached_counted = excluded.uncached_counted,
  cache_write_tokens = excluded.cache_write_tokens,
  cache_write_counted = excluded.cache_write_counted,
  output_tokens = excluded.output_tokens,
  output_counted = excluded.output_counted,
  reasoning_tokens = excluded.reasoning_tokens,
  reasoning_counted = excluded.reasoning_counted,
  accounting_basis = excluded.accounting_basis,
  source_version = excluded.source_version,
  batch_seq = excluded.batch_seq,
  updated_at = excluded.updated_at
WHERE excluded.batch_seq >= usage_buckets.batch_seq`;

const INSERT_QUOTA_OBSERVATION = `INSERT INTO quota_observations (
  producer_id, sample_id, source, account, observer_machine, sampled_at,
  interval_seconds, status, time_anomaly, error_summary, ingested_at, batch_seq
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT last_batch_seq FROM producers WHERE producer_id = ?) < ?
ON CONFLICT(producer_id, sample_id) DO NOTHING`;

// Children are inserted only while this batch still owns the producer sequence
// and only for a parent observation accepted by this same batch. An observation
// already stored under an older batch_seq is immutable: a repeated sample_id
// cannot gain or replace windows.
const INSERT_QUOTA_WINDOW = `INSERT INTO quota_windows (
  producer_id, sample_id, bucket_id, slot, label, used_percent,
  remaining_percent, status, resets_at, window_duration_mins, meta_json
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT last_batch_seq FROM producers WHERE producer_id = ?) < ?
  AND EXISTS (
    SELECT 1 FROM quota_observations
    WHERE producer_id = ? AND sample_id = ? AND batch_seq = ?
  )
ON CONFLICT(producer_id, sample_id, bucket_id, slot) DO NOTHING`;

const COMMIT_PRODUCER = `UPDATE producers SET
  last_batch_seq = ?,
  display_name = ?,
  scopes_json = ?,
  expected_interval_seconds = ?,
  last_heartbeat_at = ?,
  last_attempt_at = ?,
  last_status = 'ok',
  last_error = NULL,
  updated_at = ?
WHERE producer_id = ? AND last_batch_seq < ?`;

type CommitResult = "ok" | "duplicate" | "stale";

function usageStatement(
  env: Env,
  producer: ProducerConfig,
  bucket: UsageBucketInput,
  sequence: number,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(UPSERT_USAGE).bind(
    producer.producerId,
    bucket.source,
    bucket.account,
    bucket.actor_kind,
    bucket.actor_id,
    bucket.model,
    bucket.effort,
    bucket.bucket_start,
    bucket.unit_kind,
    bucket.unit_count,
    bucket.coverage_gaps,
    bucket.input_tokens,
    bucket.input_counted,
    bucket.cached_tokens,
    bucket.cached_counted,
    bucket.uncached_tokens,
    bucket.uncached_counted,
    bucket.cache_write_tokens,
    bucket.cache_write_counted,
    bucket.output_tokens,
    bucket.output_counted,
    bucket.reasoning_tokens,
    bucket.reasoning_counted,
    bucket.accounting_basis,
    bucket.source_version,
    sequence,
    now,
    producer.producerId,
    sequence,
  );
}

function quotaObservationStatement(
  env: Env,
  producer: ProducerConfig,
  observation: QuotaObservationInput,
  sequence: number,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(INSERT_QUOTA_OBSERVATION).bind(
    producer.producerId,
    observation.sample_id,
    observation.source,
    observation.account,
    observation.observer_machine,
    observation.sampled_at,
    observation.interval_seconds,
    observation.status,
    observation.time_anomaly,
    observation.error_summary,
    now,
    sequence,
    producer.producerId,
    sequence,
  );
}

function quotaWindowStatement(
  env: Env,
  producer: ProducerConfig,
  observation: QuotaObservationInput,
  window: QuotaWindowInput,
  sequence: number,
): D1PreparedStatement {
  return env.DB.prepare(INSERT_QUOTA_WINDOW).bind(
    producer.producerId,
    observation.sample_id,
    window.bucket_id,
    window.slot,
    window.label,
    window.used_percent,
    window.remaining_percent,
    window.status,
    window.resets_at,
    window.window_duration_mins,
    window.meta_json,
    producer.producerId,
    sequence,
    producer.producerId,
    observation.sample_id,
    sequence,
  );
}

export async function commitIngestBatch(
  env: Env,
  producer: ProducerConfig,
  envelope: IngestEnvelope,
): Promise<CommitResult> {
  const now = new Date().toISOString();
  const scopesJson = JSON.stringify(producer.scopes);
  const statements: Array<D1PreparedStatement> = [
    env.DB.prepare(INSERT_PRODUCER).bind(
      producer.producerId,
      producer.displayName,
      scopesJson,
      producer.expectedIntervalSeconds,
      now,
    ),
  ];

  for (const bucket of envelope.usage_buckets) {
    statements.push(usageStatement(env, producer, bucket, envelope.batch_seq, now));
  }

  for (const observation of envelope.quota_observations) {
    statements.push(quotaObservationStatement(env, producer, observation, envelope.batch_seq, now));
    for (const window of observation.windows) {
      statements.push(quotaWindowStatement(env, producer, observation, window, envelope.batch_seq));
    }
  }

  statements.push(
    env.DB.prepare(COMMIT_PRODUCER).bind(
      envelope.batch_seq,
      producer.displayName,
      scopesJson,
      producer.expectedIntervalSeconds,
      now,
      now,
      now,
      producer.producerId,
      envelope.batch_seq,
    ),
  );

  const results = await env.DB.batch(statements);
  const committed = (results.at(-1)?.meta.changes ?? 0) > 0;
  if (committed) {
    return "ok";
  }

  const current = await env.DB.prepare("SELECT last_batch_seq FROM producers WHERE producer_id = ?")
    .bind(producer.producerId)
    .first<{ last_batch_seq: number }>();
  if (current === null) {
    throw new Error("producer row is missing after ingest");
  }
  return current.last_batch_seq === envelope.batch_seq ? "duplicate" : "stale";
}

export type IngestResponseBody =
  | { status: "ok"; batch_seq: number; rows: number }
  | { status: "duplicate"; batch_seq: number }
  | { error: string };

export interface IngestResponse {
  status: 200 | 400 | 401 | 403 | 409 | 413 | 500 | 503;
  body: IngestResponseBody;
}

async function readBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > MAX_INGEST_BYTES) {
      return null;
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_INGEST_BYTES) {
    return null;
  }
  return text;
}

export async function handleIngest(request: Request, env: Env): Promise<IngestResponse> {
  let producers: Array<ProducerConfig> | null;
  try {
    producers = parseProducerConfigs(env.INGEST_PRODUCERS_JSON);
  } catch (error) {
    if (error instanceof IngestConfigError) {
      return { status: 503, body: { error: "ingest_not_configured" } };
    }
    throw error;
  }
  if (producers === null) {
    return { status: 503, body: { error: "ingest_not_configured" } };
  }

  const token = bearerToken(request);
  if (!token) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const producer = await resolveProducer(token, producers);
  if (!producer) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const text = await readBody(request);
  if (text === null) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return { status: 400, body: { error: "invalid_payload" } };
  }

  const envelope = parseEnvelope(parsedJson);
  if (!envelope.ok) {
    return { status: 400, body: { error: "invalid_payload" } };
  }

  // Balance push is not part of the v1 producer contract. Every non-empty
  // usage or quota row must be covered by an explicit (source, kind) scope.
  if (envelope.value.balance_snapshots.length > 0) {
    return { status: 403, body: { error: "forbidden_scope" } };
  }
  for (const bucket of envelope.value.usage_buckets) {
    if (!scopeAllows(producer, bucket.source, "usage_buckets")) {
      return { status: 403, body: { error: "forbidden_scope" } };
    }
  }
  for (const observation of envelope.value.quota_observations) {
    if (!scopeAllows(producer, observation.source, "quota_observations")) {
      return { status: 403, body: { error: "forbidden_scope" } };
    }
  }

  let result: CommitResult;
  try {
    result = await commitIngestBatch(env, producer, envelope.value);
  } catch {
    return { status: 500, body: { error: "storage_write_failed" } };
  }

  if (result === "stale") {
    return { status: 409, body: { error: "stale_batch" } };
  }
  if (result === "duplicate") {
    return {
      status: 200,
      body: { status: "duplicate", batch_seq: envelope.value.batch_seq },
    };
  }
  return {
    status: 200,
    body: {
      status: "ok",
      batch_seq: envelope.value.batch_seq,
      rows: ingestRowCount(envelope.value),
    },
  };
}
