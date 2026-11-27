import type { QuotaObservation, QuotaSubject } from "./index";

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
