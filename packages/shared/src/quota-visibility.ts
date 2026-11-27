import type { QuotaAttempt, QuotaObservation, QuotaSubject } from "./index";

const DAY_MS = 86_400_000;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60_000;

/** OpenCode Go keys older than this are omitted from the dashboard surface. */
export const OPENCODE_QUOTA_VISIBILITY_MS = 7 * DAY_MS;

type ObservationLike = Pick<QuotaObservation, "sampled_at" | "time_anomaly">;

function trustworthyObservationMs(subject: QuotaSubject, nowMs: number): number | null {
  const candidates: Array<ObservationLike> = [];
  if (subject.latest_attempt !== null) {
    candidates.push(subject.latest_attempt);
  }
  if (subject.latest_valid !== null) {
    candidates.push(subject.latest_valid);
  }

  let latest: number | null = null;
  for (const observation of candidates) {
    if (observation.time_anomaly !== null) {
      continue;
    }
    const parsed = Date.parse(observation.sampled_at);
    if (!Number.isFinite(parsed) || parsed > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
      continue;
    }
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

/**
 * The display rule applies only to OpenCode Go key subjects. A failed or empty
 * non-anomalous attempt counts as a recent observation, but a future-anomalous
 * timestamp never extends visibility.
 */
export function isQuotaSubjectVisible(subject: QuotaSubject, now: Date): boolean {
  if (subject.source !== "opencode") {
    return true;
  }
  const observedAt = trustworthyObservationMs(subject, now.getTime());
  if (observedAt === null) {
    return false;
  }
  return now.getTime() - observedAt < OPENCODE_QUOTA_VISIBILITY_MS;
}

export function filterVisibleQuotaSubjects(
  subjects: ReadonlyArray<QuotaSubject>,
  now: Date,
): Array<QuotaSubject> {
  return subjects.filter((subject) => isQuotaSubjectVisible(subject, now));
}

function withoutFingerprint(value: string, fingerprint: string, label: string): string {
  return fingerprint.length === 0 ? value : value.split(fingerprint).join(label);
}

function publicErrorSummary(
  summary: string | null,
  fingerprint: string,
  label: string,
): string | null {
  return summary === null ? null : withoutFingerprint(summary, fingerprint, label);
}

function publicAttempt(attempt: QuotaAttempt, fingerprint: string, label: string): QuotaAttempt {
  return {
    ...attempt,
    sample_id: withoutFingerprint(attempt.sample_id, fingerprint, label),
    error_summary: publicErrorSummary(attempt.error_summary, fingerprint, label),
  };
}

function publicOpenCodeSubject(subject: QuotaSubject, label: string): QuotaSubject {
  return {
    source: subject.source,
    account: label,
    latest_valid:
      subject.latest_valid === null
        ? null
        : {
            ...subject.latest_valid,
            sample_id: withoutFingerprint(subject.latest_valid.sample_id, subject.account, label),
            error_summary: publicErrorSummary(
              subject.latest_valid.error_summary,
              subject.account,
              label,
            ),
            windows: subject.latest_valid.windows.map((window) => ({
              ...window,
              bucket_id: withoutFingerprint(window.bucket_id, subject.account, label),
              // Upstream key aliases are not a verified public label, so they
              // never reach the dashboard surface.
              label: null,
            })),
          },
    latest_attempt:
      subject.latest_attempt === null
        ? null
        : publicAttempt(subject.latest_attempt, subject.account, label),
    anomalies: subject.anomalies.map((anomaly) => publicAttempt(anomaly, subject.account, label)),
  };
}

/**
 * The public dashboard projection for quota subjects.
 *
 * Every OpenCode Go key is exposed only as an anonymous `Go#N`. Numbering runs
 * over the full subject list before the freshness filter, so an aged-out legacy
 * key still holds its number instead of renumbering the visible keys. Raw key
 * fingerprints are also removed from every sample, bucket, and error identity
 * sent to the dashboard. Other sources keep their existing display fields.
 */
export function dashboardQuotaSubjects(
  subjects: ReadonlyArray<QuotaSubject>,
  now: Date,
): Array<QuotaSubject> {
  let openCodeNumber = 0;
  const projected = subjects.map((subject) => {
    if (subject.source !== "opencode") {
      return subject;
    }
    openCodeNumber += 1;
    return publicOpenCodeSubject(subject, `Go#${openCodeNumber}`);
  });
  return filterVisibleQuotaSubjects(projected, now);
}
