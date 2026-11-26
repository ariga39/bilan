import type {
  QuotaAnomaly,
  QuotaAttempt,
  QuotaObservation,
  QuotaObservationStatus,
  QuotaResponse,
  QuotaWindow,
  QuotaWindowStatus,
} from "@bilan/shared";
import { Hono } from "hono";

import type { Env } from "./types";

interface LatestValidRow {
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
  bucket_id: string | null;
  slot: string | null;
  label: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  window_status: string | null;
  resets_at: string | null;
  window_duration_mins: number | null;
}

interface AttemptRow {
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
  is_anomaly: number;
  rank_number: number;
}

interface MutableSubject {
  source: string;
  account: string;
  latest_valid: QuotaObservation | null;
  latest_attempt: QuotaAttempt | null;
  anomalies: Array<QuotaAnomaly>;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const MAX_ANOMALIES_PER_SUBJECT = 5;

const LATEST_VALID_WITH_WINDOWS = `WITH latest_valid AS (
  SELECT producer_id, sample_id, source, account, observer_machine, sampled_at,
         interval_seconds, status, time_anomaly, error_summary, ingested_at,
         ROW_NUMBER() OVER (
           PARTITION BY source, account
           ORDER BY sampled_at DESC, ingested_at DESC
         ) AS rank_number
  FROM quota_observations
  WHERE status = 'ok' AND time_anomaly IS NULL
)
SELECT l.producer_id, l.sample_id, l.source, l.account, l.observer_machine,
       l.sampled_at, l.interval_seconds, l.status, l.time_anomaly, l.error_summary,
       l.ingested_at,
       w.bucket_id, w.slot, w.label, w.used_percent, w.remaining_percent,
       w.status AS window_status, w.resets_at, w.window_duration_mins
FROM latest_valid l
LEFT JOIN quota_windows w
  ON w.producer_id = l.producer_id AND w.sample_id = l.sample_id
WHERE l.rank_number = 1
ORDER BY l.source, l.account, w.bucket_id,
         CASE w.slot
           WHEN 'rolling' THEN 0
           WHEN '5h' THEN 1
           WHEN 'weekly' THEN 2
           WHEN 'monthly' THEN 3
           ELSE 4
         END,
         w.slot`;

// The latest non-anomalous attempt and the newest anomalous attempts are
// selected separately so a failed/empty sample cannot hide the latest valid
// windows, and an anomaly cannot silently replace them.
const LATEST_ATTEMPTS_WITH_ANOMALIES = `WITH ranked AS (
  SELECT producer_id, sample_id, source, account, observer_machine, sampled_at,
         interval_seconds, status, time_anomaly, error_summary, ingested_at,
         CASE WHEN time_anomaly IS NOT NULL THEN 1 ELSE 0 END AS is_anomaly,
         ROW_NUMBER() OVER (
           PARTITION BY source, account,
             CASE WHEN time_anomaly IS NOT NULL THEN 1 ELSE 0 END
           ORDER BY sampled_at DESC, ingested_at DESC
         ) AS rank_number
  FROM quota_observations
)
SELECT * FROM ranked
WHERE (is_anomaly = 0 AND rank_number = 1)
   OR (is_anomaly = 1 AND rank_number <= ?)
ORDER BY source, account, is_anomaly, sampled_at DESC, ingested_at DESC`;

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ageSeconds(nowMs: number, timestamp: string | null): number | null {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) {
    return null;
  }
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function resetSeconds(nowMs: number, timestamp: string | null): number | null {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) {
    return null;
  }
  return Math.max(0, Math.round((parsed - nowMs) / 1000));
}

function observationStatus(value: string): QuotaObservationStatus {
  if (value === "ok" || value === "empty") {
    return value;
  }
  return "error";
}

function windowStatus(value: string | null): QuotaWindowStatus | null {
  if (value === "ok" || value === "limited" || value === "cooldown" || value === "unknown") {
    return value;
  }
  return value === null ? null : "unknown";
}

function isStale(age: number | null, intervalSeconds: number | null): boolean {
  if (age === null) {
    return true;
  }
  const interval = Math.max(1, intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  return age > interval * 2;
}

function subjectFor(
  subjects: Map<string, MutableSubject>,
  source: string,
  account: string,
): MutableSubject {
  const key = `${source}\u0000${account}`;
  let subject = subjects.get(key);
  if (!subject) {
    subject = {
      source,
      account,
      latest_valid: null,
      latest_attempt: null,
      anomalies: [],
    };
    subjects.set(key, subject);
  }
  return subject;
}

function validObservation(row: LatestValidRow, nowMs: number): QuotaObservation {
  const age = ageSeconds(nowMs, row.sampled_at);
  return {
    sample_id: row.sample_id,
    observer_machine: row.observer_machine,
    sampled_at: row.sampled_at,
    interval_seconds: row.interval_seconds,
    sample_age_seconds: age,
    is_stale: isStale(age, row.interval_seconds),
    status: observationStatus(row.status),
    time_anomaly: row.time_anomaly,
    error_summary: row.error_summary,
    windows: [],
  };
}

function windowView(row: LatestValidRow, nowMs: number): QuotaWindow | null {
  if (row.bucket_id === null || row.slot === null) {
    return null;
  }
  return {
    bucket_id: row.bucket_id,
    slot: row.slot,
    label: row.label,
    used_percent: row.used_percent,
    remaining_percent: row.remaining_percent,
    status: windowStatus(row.window_status),
    resets_at: row.resets_at,
    reset_in_seconds: resetSeconds(nowMs, row.resets_at),
    window_duration_mins: row.window_duration_mins,
  };
}

function attemptView(row: AttemptRow, nowMs: number): QuotaAttempt {
  return {
    sample_id: row.sample_id,
    observer_machine: row.observer_machine,
    sampled_at: row.sampled_at,
    sample_age_seconds: ageSeconds(nowMs, row.sampled_at),
    status: observationStatus(row.status),
    time_anomaly: row.time_anomaly,
    error_summary: row.error_summary,
  };
}

/**
 * Latest valid quota per (source, account).
 *
 * The current view is built exclusively from the single latest observation with
 * `status = 'ok' AND time_anomaly IS NULL`. Older samples are never merged into
 * it, so a window that disappeared from the latest sample disappears from the
 * view. Failed/empty attempts and anomalous observations are returned
 * separately and never converted into percentages.
 *
 * Explicit `time_anomaly` values are handled here. Future-clock skew without an
 * upstream anomaly flag is the B4 clock-safety extension, not reimplemented in
 * this B3 base query.
 */
export async function getQuotaOverview(
  db: D1Database,
  now: Date = new Date(),
): Promise<QuotaResponse> {
  const nowMs = now.getTime();
  const [validResult, attemptResult] = await Promise.all([
    db.prepare(LATEST_VALID_WITH_WINDOWS).all<LatestValidRow>(),
    db.prepare(LATEST_ATTEMPTS_WITH_ANOMALIES).bind(MAX_ANOMALIES_PER_SUBJECT).all<AttemptRow>(),
  ]);

  const subjects = new Map<string, MutableSubject>();

  for (const row of validResult.results) {
    const subject = subjectFor(subjects, row.source, row.account);
    const latest = subject.latest_valid ?? validObservation(row, nowMs);
    subject.latest_valid = latest;
    const window = windowView(row, nowMs);
    if (window !== null) {
      latest.windows.push(window);
    }
  }

  for (const row of attemptResult.results) {
    const subject = subjectFor(subjects, row.source, row.account);
    if (row.is_anomaly === 0) {
      subject.latest_attempt = attemptView(row, nowMs);
    } else {
      subject.anomalies.push(attemptView(row, nowMs));
    }
  }

  return {
    generated_at: now.toISOString(),
    subjects: [...subjects.values()].sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.account.localeCompare(right.account),
    ),
  };
}

export const quotaRoutes = new Hono<{ Bindings: Env }>();

quotaRoutes.get("/api/v1/quotas", async (context) => {
  const quota = await getQuotaOverview(context.env.DB, new Date());
  context.header("cache-control", "no-store");
  return context.json(quota);
});
