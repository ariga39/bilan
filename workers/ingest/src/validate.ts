import { z } from "zod";

export const MAX_INGEST_ROWS = 500;
export const MAX_INGEST_BYTES = 512 * 1024;

function isValidUtcHour(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 13) === value.slice(0, 13);
}

function isValidUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 19) + "Z" === value;
}

const tokenValue = z.number().int().nonnegative().nullable();

const usageBucketSchema = z
  .object({
    source: z.string().min(1).max(64),
    account: z.string().min(1).max(128).default("default"),
    actor_kind: z.enum(["machine", "identity"]),
    actor_id: z.string().min(1).max(128).default("unknown"),
    model: z.string().min(1).max(128).default("unknown"),
    effort: z.string().max(128).default(""),
    bucket_start: z.string().refine(isValidUtcHour, "bucket_start must be an aligned UTC hour"),
    unit_kind: z.enum(["request", "step"]),
    unit_count: z.number().int().nonnegative(),
    coverage_gaps: z.number().int().nonnegative(),
    input_tokens: tokenValue,
    input_counted: z.number().int().nonnegative(),
    cached_tokens: tokenValue,
    cached_counted: z.number().int().nonnegative(),
    uncached_tokens: tokenValue,
    uncached_counted: z.number().int().nonnegative(),
    cache_write_tokens: tokenValue,
    cache_write_counted: z.number().int().nonnegative(),
    output_tokens: tokenValue,
    output_counted: z.number().int().nonnegative(),
    reasoning_tokens: tokenValue,
    reasoning_counted: z.number().int().nonnegative(),
    accounting_basis: z.string().min(1).max(128).default("unknown"),
    source_version: z.string().min(1).max(128).default("unknown"),
  })
  .superRefine((bucket, context) => {
    if (bucket.coverage_gaps > bucket.unit_count) {
      context.addIssue({
        code: "custom",
        message: "coverage_gaps cannot exceed unit_count",
        path: ["coverage_gaps"],
      });
    }
    for (const column of [
      "input_counted",
      "cached_counted",
      "uncached_counted",
      "cache_write_counted",
      "output_counted",
      "reasoning_counted",
    ] as const) {
      if (bucket[column] > bucket.unit_count) {
        context.addIssue({
          code: "custom",
          message: `${column} cannot exceed unit_count`,
          path: [column],
        });
      }
    }
  });

export type UsageBucketInput = z.infer<typeof usageBucketSchema>;

const quotaWindowSchema = z.object({
  bucket_id: z.string().min(1).max(128),
  slot: z.string().min(1).max(64),
  label: z.string().max(128).nullable().default(null),
  used_percent: z.number().min(0).max(100).nullable().default(null),
  remaining_percent: z.number().min(0).max(100).nullable().default(null),
  status: z.enum(["ok", "limited", "cooldown", "unknown"]).nullable().default(null),
  resets_at: z
    .string()
    .refine(isValidUtcTimestamp, "resets_at must be a UTC ISO-8601 timestamp")
    .nullable()
    .default(null),
  window_duration_mins: z.number().int().positive().nullable().default(null),
  meta_json: z.string().max(2048).nullable().default(null),
});

export type QuotaWindowInput = z.infer<typeof quotaWindowSchema>;

const quotaObservationSchema = z
  .object({
    sample_id: z.string().min(1).max(512),
    source: z.string().min(1).max(64),
    account: z.string().min(1).max(128).default("default"),
    observer_machine: z.string().min(1).max(128).default("unknown"),
    sampled_at: z
      .string()
      .refine(isValidUtcTimestamp, "sampled_at must be a UTC ISO-8601 timestamp"),
    interval_seconds: z.number().int().positive().nullable().default(null),
    status: z.enum(["ok", "empty", "error"]),
    time_anomaly: z.string().max(512).nullable().default(null),
    error_summary: z.string().max(512).nullable().default(null),
    windows: z.array(quotaWindowSchema).default([]),
  })
  .superRefine((observation, context) => {
    const seen = new Set<string>();
    observation.windows.forEach((window, index) => {
      const key = `${window.bucket_id}\u0000${window.slot}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "quota window bucket_id and slot must be unique",
          path: ["windows", index],
        });
      }
      seen.add(key);
    });
  });

export type QuotaObservationInput = z.infer<typeof quotaObservationSchema>;

export interface IngestEnvelope {
  schema_version: 1;
  batch_seq: number;
  usage_buckets: Array<UsageBucketInput>;
  quota_observations: Array<QuotaObservationInput>;
  balance_snapshots: Array<unknown>;
}

/** Count storage rows, including each observation's child windows. */
export function ingestRowCount(
  envelope: Pick<IngestEnvelope, "usage_buckets" | "quota_observations" | "balance_snapshots">,
): number {
  return (
    envelope.usage_buckets.length +
    envelope.balance_snapshots.length +
    envelope.quota_observations.reduce(
      (total, observation) => total + 1 + observation.windows.length,
      0,
    )
  );
}

const envelopeSchema: z.ZodType<IngestEnvelope> = z
  .object({
    schema_version: z.literal(1),
    batch_seq: z.number().int().positive(),
    usage_buckets: z.array(usageBucketSchema).default([]),
    quota_observations: z.array(quotaObservationSchema).default([]),
    balance_snapshots: z.array(z.unknown()).default([]),
  })
  .superRefine((envelope, context) => {
    if (ingestRowCount(envelope) > MAX_INGEST_ROWS) {
      context.addIssue({
        code: "custom",
        message: `payload exceeds ${MAX_INGEST_ROWS} rows`,
        path: ["batch_rows"],
      });
    }
    const sampleIds = new Set<string>();
    envelope.quota_observations.forEach((observation, index) => {
      if (sampleIds.has(observation.sample_id)) {
        context.addIssue({
          code: "custom",
          message: "sample_id must be unique within a batch",
          path: ["quota_observations", index, "sample_id"],
        });
      }
      sampleIds.add(observation.sample_id);
    });
  });

export function parseEnvelope(value: unknown): { ok: true; value: IngestEnvelope } | { ok: false } {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, value: parsed.data };
}
