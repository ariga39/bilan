import { getJson } from "@/lib/api";
import type { ResponseSchema } from "@/lib/api";

export type QuotaWindowStatus = "ok" | "limited" | "cooldown" | "unknown";
export type QuotaObservationStatus = "ok" | "empty" | "error";

export interface QuotaWindow {
  bucket_id: string;
  slot: string;
  label: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  status: QuotaWindowStatus | null;
  resets_at: string | null;
  reset_in_seconds: number | null;
  window_duration_mins: number | null;
}

export interface QuotaObservation {
  sample_id: string;
  observer_machine: string;
  sampled_at: string;
  interval_seconds: number | null;
  sample_age_seconds: number | null;
  is_stale: boolean;
  status: QuotaObservationStatus;
  time_anomaly: string | null;
  error_summary: string | null;
  windows: Array<QuotaWindow>;
}

export interface QuotaAttempt {
  sample_id: string;
  observer_machine: string;
  sampled_at: string;
  sample_age_seconds: number | null;
  status: QuotaObservationStatus;
  time_anomaly: string | null;
  error_summary: string | null;
}

export type QuotaAnomaly = QuotaAttempt;

export interface QuotaSubject {
  source: string;
  account: string;
  latest_valid: QuotaObservation | null;
  latest_attempt: QuotaAttempt | null;
  anomalies: Array<QuotaAnomaly>;
}

export interface QuotaResponse {
  generated_at: string;
  subjects: Array<QuotaSubject>;
}

type JsonValue = string | number | boolean | null | Array<JsonValue> | { [key: string]: JsonValue };

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isWindowStatus(value: unknown): value is QuotaWindowStatus | null {
  return (
    value === null ||
    value === "ok" ||
    value === "limited" ||
    value === "cooldown" ||
    value === "unknown"
  );
}

function isObservationStatus(value: unknown): value is QuotaObservationStatus {
  return value === "ok" || value === "empty" || value === "error";
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
  return (
    isRecord(value) &&
    typeof value.bucket_id === "string" &&
    typeof value.slot === "string" &&
    isNullableString(value.label) &&
    isNullableNumber(value.used_percent) &&
    isNullableNumber(value.remaining_percent) &&
    isWindowStatus(value.status) &&
    isNullableString(value.resets_at) &&
    isNullableNumber(value.reset_in_seconds) &&
    isNullableNumber(value.window_duration_mins)
  );
}

function isQuotaObservation(value: unknown): value is QuotaObservation {
  return (
    isRecord(value) &&
    typeof value.sample_id === "string" &&
    typeof value.observer_machine === "string" &&
    typeof value.sampled_at === "string" &&
    isNullableNumber(value.interval_seconds) &&
    isNullableNumber(value.sample_age_seconds) &&
    typeof value.is_stale === "boolean" &&
    isObservationStatus(value.status) &&
    isNullableString(value.time_anomaly) &&
    isNullableString(value.error_summary) &&
    Array.isArray(value.windows) &&
    value.windows.every(isQuotaWindow)
  );
}

function isQuotaAttempt(value: unknown): value is QuotaAttempt {
  return (
    isRecord(value) &&
    typeof value.sample_id === "string" &&
    typeof value.observer_machine === "string" &&
    typeof value.sampled_at === "string" &&
    isNullableNumber(value.sample_age_seconds) &&
    isObservationStatus(value.status) &&
    isNullableString(value.time_anomaly) &&
    isNullableString(value.error_summary)
  );
}

function isQuotaSubject(value: unknown): value is QuotaSubject {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.account === "string" &&
    (value.latest_valid === null || isQuotaObservation(value.latest_valid)) &&
    (value.latest_attempt === null || isQuotaAttempt(value.latest_attempt)) &&
    Array.isArray(value.anomalies) &&
    value.anomalies.every(isQuotaAttempt)
  );
}

function isQuotaResponse(value: unknown): value is QuotaResponse {
  return (
    isRecord(value) &&
    typeof value.generated_at === "string" &&
    Array.isArray(value.subjects) &&
    value.subjects.every(isQuotaSubject)
  );
}

const quotaResponseSchema: ResponseSchema<QuotaResponse> = {
  safeParse(value: unknown) {
    return isQuotaResponse(value) ? { success: true, data: value } : { success: false as const };
  },
};

export function fetchQuota(signal?: AbortSignal): Promise<QuotaResponse> {
  return getJson("/api/v1/quotas", quotaResponseSchema, signal);
}
