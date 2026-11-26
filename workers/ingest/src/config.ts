import { z } from "zod";

export const INGEST_KINDS = ["usage_buckets", "quota_observations", "balance_snapshots"] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

export interface ProducerScope {
  source: string;
  kind: IngestKind;
}

export interface ProducerConfig {
  producerId: string;
  tokenSha256: string;
  displayName: string;
  expectedIntervalSeconds: number;
  scopes: ReadonlyArray<ProducerScope>;
}

const producerScopeSchema = z.object({
  source: z.string().min(1).max(64),
  kind: z.enum(INGEST_KINDS),
});

const producerConfigSchema = z.object({
  token_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  display_name: z.string().min(1).max(200),
  expected_interval_seconds: z.number().int().positive().default(3600),
  scopes: z.array(producerScopeSchema).default([]),
});

const producerMapSchema = z.record(z.string().min(1).max(128), producerConfigSchema);

export class IngestConfigError extends Error {
  override readonly name = "IngestConfigError";
}

export function parseProducerConfigs(raw: string | undefined): Array<ProducerConfig> | null {
  if (!raw) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IngestConfigError("INGEST_PRODUCERS_JSON is not valid JSON");
  }

  const parsed = producerMapSchema.safeParse(value);
  if (!parsed.success) {
    throw new IngestConfigError("INGEST_PRODUCERS_JSON has an invalid shape");
  }

  return Object.entries(parsed.data).map(([producerId, config]) => ({
    producerId,
    tokenSha256: config.token_sha256.toLowerCase(),
    displayName: config.display_name,
    expectedIntervalSeconds: config.expected_interval_seconds,
    scopes: config.scopes,
  }));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function resolveProducer(
  token: string,
  producers: ReadonlyArray<ProducerConfig>,
): Promise<ProducerConfig | null> {
  const hash = await sha256Hex(token);
  let matched: ProducerConfig | null = null;
  for (const producer of producers) {
    if (constantTimeEqualHex(hash, producer.tokenSha256)) {
      matched = producer;
    }
  }
  return matched;
}

export function scopeAllows(producer: ProducerConfig, source: string, kind: IngestKind): boolean {
  return producer.scopes.some((scope) => scope.source === source && scope.kind === kind);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || null;
}
