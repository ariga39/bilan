import { overviewResponseSchema } from "@bilan/shared/schemas";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev } from "wrangler";

import { QuotaSection } from "@/components/quota-section";
import { UsageSection } from "@/components/usage-section";

type DevWorker = Awaited<ReturnType<typeof unstable_dev>>;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const ORIHSUS_TOKEN = "test-orihsus-token";
const DEBITMETRE_TOKEN = "test-debitmetre-token";
const TELEMETRE_TOKEN = "test-telemetre-token";
const PRODUCERS_JSON = JSON.stringify({
  "debitmetre-main": {
    token_sha256: "c6c726663d39185c46966f2075416a8b8348523b809c7e09f1ea984631e98a9b",
    display_name: "debitmetre (Codex usage)",
    expected_interval_seconds: 3600,
    scopes: [{ source: "codex", kind: "usage_buckets" }],
  },
  "orihsus-main": {
    token_sha256: "174b251f753833d225882771a1488413ea9170f1db266b60491772948b7bccdd",
    display_name: "orihsus (OpenCode Go)",
    expected_interval_seconds: 1800,
    scopes: [
      { source: "opencode", kind: "usage_buckets" },
      { source: "opencode", kind: "quota_observations" },
    ],
  },
  "telemetre-quota": {
    token_sha256: "da822ee843c11c977d04fa8914d6ddd33161258e734b46853aac031d2e63e403",
    display_name: "telemetre (AGY + Codex quota)",
    expected_interval_seconds: 1800,
    scopes: [
      { source: "agy", kind: "quota_observations" },
      { source: "codex", kind: "quota_observations" },
    ],
  },
});

let tempDir = "";
let ingest: DevWorker | null = null;
let web: DevWorker | null = null;

function baseUrl(worker: DevWorker): string {
  const host =
    worker.address === "0.0.0.0" || worker.address === "::" ? "127.0.0.1" : worker.address;
  return `http://${host}:${worker.port}`;
}

interface HttpResponse {
  status: number;
  body: string;
}

function httpCall(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function requireSuccess(result: ReturnType<typeof spawnSync>, label: string): void {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function writeJsonl(file: string, records: Array<unknown>): void {
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function auditRecord(timestamp: string, requestId: string, status: number, withUsage: boolean) {
  return {
    timestamp,
    request_id: requestId,
    model: withUsage ? "deepseek-chat" : null,
    key_fingerprint: withUsage ? "fp_a" : null,
    gateway_key: "laptop-key",
    input_tokens: withUsage ? 100 : null,
    cached_tokens: withUsage ? 40 : null,
    uncached_tokens: withUsage ? 60 : null,
    cache_write_tokens: null,
    output_tokens: withUsage ? 20 : null,
    reasoning_tokens: withUsage ? 4 : null,
    status,
    outcome: withUsage ? "completed" : "upstream_error",
    latency_ms: 150,
    opencode_session_id: null,
    opencode_project_id: null,
    opencode_request_id: null,
    attempts: [],
  };
}

interface UsageWindowRecord {
  status: string;
  percent: number;
  resetsAt: string;
}

interface UsageHistoryRecord {
  timestamp: string;
  key_fingerprint: string;
  key_alias?: string;
  rolling: UsageWindowRecord;
  weekly: UsageWindowRecord;
  monthly?: UsageWindowRecord;
}

function usageRecord(
  timestamp: string,
  keyFingerprint: string,
  rollingPercent: number,
  includeMonthly: boolean,
  keyAlias?: string,
): UsageHistoryRecord {
  const record: UsageHistoryRecord = {
    timestamp,
    key_fingerprint: keyFingerprint,
    rolling: {
      status: "ok",
      percent: rollingPercent,
      resetsAt: "2026-11-27T12:15:00Z",
    },
    weekly: {
      status: "ok",
      percent: 20,
      resetsAt: "2026-12-01T00:00:00Z",
    },
  };
  if (keyAlias) {
    record.key_alias = keyAlias;
  }
  if (includeMonthly) {
    record.monthly = {
      status: "ok",
      percent: 30,
      resetsAt: "2026-12-31T00:00:00Z",
    };
  }
  return record;
}

// The synthetic centre database uses telemetre's real quota_samples /
// quota_windows schema. The E2E inserts directly; the shipper only reads it.
const CENTRE_SCHEMA = `
CREATE TABLE quota_samples (
    sample_id        TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    account          TEXT NOT NULL,
    machine          TEXT NOT NULL,
    sampled_at       TEXT NOT NULL,
    sampled_epoch    REAL NOT NULL,
    received_at      TEXT NOT NULL,
    received_epoch   REAL NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('success', 'failure')),
    error_kind       TEXT,
    error_detail     TEXT,
    empty_windows    INTEGER NOT NULL DEFAULT 0,
    time_anomaly     INTEGER NOT NULL DEFAULT 0,
    interval_seconds INTEGER NOT NULL,
    collector_version TEXT NOT NULL,
    payload_digest   TEXT NOT NULL
);
CREATE INDEX quota_samples_account_time
    ON quota_samples (provider, account, sampled_epoch DESC, received_epoch DESC);
CREATE INDEX quota_samples_time
    ON quota_samples (sampled_epoch);

CREATE TABLE quota_windows (
    sample_id         TEXT NOT NULL REFERENCES quota_samples(sample_id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    group_name        TEXT NOT NULL,
    bucket_id         TEXT NOT NULL,
    limit_id          TEXT,
    slot              TEXT,
    window_raw        TEXT,
    window_minutes    INTEGER,
    remaining_value   REAL,
    remaining_unit    TEXT,
    remaining_display REAL,
    reset_raw         TEXT,
    reset_at          TEXT,
    anomalies         TEXT NOT NULL,
    PRIMARY KEY (sample_id, ordinal)
);
`;

interface CentreWindow {
  groupName: string;
  bucketId: string;
  limitId?: string | null;
  slot?: string | null;
  windowRaw?: unknown;
  windowMinutes?: number | null;
  remainingValue?: number | null;
  remainingUnit?: string | null;
  remainingDisplay?: number | null;
  resetRaw?: unknown;
  resetAt?: string | null;
  anomalies?: Array<string>;
}

interface CentreSample {
  sampleId: string;
  provider: "agy" | "codex";
  account: string;
  machine?: string;
  sampledAt: string;
  receivedAt?: string;
  status?: "success" | "failure";
  errorKind?: string | null;
  errorDetail?: string | null;
  emptyWindows?: boolean;
  timeAnomaly?: boolean;
  intervalSeconds?: number;
  windows?: Array<CentreWindow>;
}

function epochSeconds(timestamp: string): number {
  return Date.parse(timestamp) / 1000;
}

function insertCentreSample(db: DatabaseSync, sample: CentreSample): void {
  const receivedAt = sample.receivedAt ?? sample.sampledAt;
  db.prepare(
    `INSERT INTO quota_samples (
       sample_id, provider, account, machine, sampled_at, sampled_epoch,
       received_at, received_epoch, status, error_kind, error_detail,
       empty_windows, time_anomaly, interval_seconds, collector_version,
       payload_digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sample.sampleId,
    sample.provider,
    sample.account,
    sample.machine ?? "studio-a",
    sample.sampledAt,
    epochSeconds(sample.sampledAt),
    receivedAt,
    epochSeconds(receivedAt),
    sample.status ?? "success",
    sample.errorKind ?? null,
    sample.errorDetail ?? null,
    sample.emptyWindows ? 1 : 0,
    sample.timeAnomaly ? 1 : 0,
    sample.intervalSeconds ?? 900,
    "telemetre-quota/0.1",
    `digest-${sample.sampleId}`,
  );

  for (const [ordinal, window] of (sample.windows ?? []).entries()) {
    db.prepare(
      `INSERT INTO quota_windows (
         sample_id, ordinal, group_name, bucket_id, limit_id, slot,
         window_raw, window_minutes, remaining_value, remaining_unit,
         remaining_display, reset_raw, reset_at, anomalies
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sample.sampleId,
      ordinal,
      window.groupName,
      window.bucketId,
      window.limitId ?? null,
      window.slot ?? null,
      JSON.stringify(window.windowRaw ?? null),
      window.windowMinutes ?? null,
      window.remainingValue ?? null,
      window.remainingUnit ?? null,
      window.remainingDisplay ?? null,
      JSON.stringify(window.resetRaw ?? null),
      window.resetAt ?? null,
      JSON.stringify(window.anomalies ?? []),
    );
  }
}

function runTelemetre(
  python: string,
  databasePath: string,
  statePath: string,
  ingestUrl: string,
): void {
  const shipper = spawnSync(
    python,
    [
      path.join(repoRoot, "shippers/telemetre.py"),
      "--database",
      databasePath,
      "--state-file",
      statePath,
      "--producer-id",
      "telemetre-quota",
      "--endpoint",
      `${ingestUrl}/api/v1/ingest`,
      "--token",
      TELEMETRE_TOKEN,
      "--timeout",
      "60",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      timeout: 60_000,
    },
  );
  requireSuccess(shipper, "real telemetre shipper CLI");
}

beforeAll(async () => {
  if (!existsSync(path.join(repoRoot, "workers/web/dist/client"))) {
    throw new Error("Run `pnpm build` before `pnpm test:e2e`.");
  }

  tempDir = mkdtempSync(path.join(tmpdir(), "bilan-quota-e2e-"));
  const stateDir = path.join(tempDir, "state");
  const migrate = spawnSync(
    "pnpm",
    [
      "--filter",
      "bilan-ingest",
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "bilan",
      "--local",
      "--persist-to",
      stateDir,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
    },
  );
  requireSuccess(migrate, "local D1 migrations");

  try {
    ingest = await unstable_dev(path.join(repoRoot, "workers/ingest/src/index.ts"), {
      config: path.join(repoRoot, "workers/ingest/wrangler.toml"),
      persistTo: stateDir,
      vars: { INGEST_PRODUCERS_JSON: PRODUCERS_JSON },
      logLevel: "none",
      experimental: { disableDevRegistry: true },
    });
    web = await unstable_dev(path.join(repoRoot, "workers/web/src/worker/index.ts"), {
      config: path.join(repoRoot, "workers/web/wrangler.toml"),
      persistTo: stateDir,
      logLevel: "none",
      experimental: { disableDevRegistry: true },
    });
  } catch (error) {
    await ingest?.stop();
    await web?.stop();
    ingest = null;
    web = null;
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await ingest?.stop();
  await web?.stop();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("B3/B4 shipper to dashboard E2E", () => {
  it("pushes OpenCode Go and Codex data through local Workers into the overview and UI", async () => {
    if (ingest === null || web === null) {
      throw new Error("local Workers did not start");
    }
    const ingestUrl = baseUrl(ingest);
    const webUrl = baseUrl(web);

    const auditPath = path.join(tempDir, "audit.jsonl");
    const usageDir = path.join(tempDir, "usage");
    const statePath = path.join(tempDir, "shipper-state.json");
    mkdirSync(usageDir, { recursive: true });
    writeJsonl(auditPath, [
      auditRecord("2026-11-26T14:05:00.123Z", "req-success", 200, true),
      auditRecord("2026-11-26T14:20:00.000Z", "req-failed", 500, false),
    ]);
    writeJsonl(path.join(usageDir, "2026-11-26.jsonl"), [
      usageRecord("2026-11-26T14:30:00.000Z", "fp_a", 42.5, true, "go-key-1"),
      usageRecord("2026-11-26T14:35:00.000Z", "fp_a", 43.5, false, "go-key-1"),
      usageRecord("2026-11-26T14:31:00.000Z", "fp_b", 90, true),
    ]);

    const ingestPing = await httpCall(`${ingestUrl}/api/v1/ingest`);
    expect([404, 405]).toContain(ingestPing.status);
    const webPing = await httpCall(`${webUrl}/api/v1/overview`);
    expect(webPing.status, webPing.body).toBe(200);

    const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const shipper = spawnSync(
      python,
      [
        path.join(repoRoot, "shippers/orihsus.py"),
        "--audit-file",
        auditPath,
        "--usage-dir",
        usageDir,
        "--state-file",
        statePath,
        "--endpoint",
        `${ingestUrl}/api/v1/ingest`,
        "--token",
        ORIHSUS_TOKEN,
        "--observer-machine",
        "gateway-a",
        "--interval-seconds",
        "300",
        "--timeout",
        "60",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        timeout: 60_000,
      },
    );
    requireSuccess(shipper, "real orihsus shipper CLI");

    const codexPush = await httpCall(`${ingestUrl}/api/v1/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEBITMETRE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        batch_seq: 1,
        usage_buckets: [
          {
            source: "codex",
            account: "default",
            actor_kind: "machine",
            actor_id: "machine-a",
            model: "gpt-5",
            effort: "high",
            bucket_start: "2026-11-26T14:00:00Z",
            unit_kind: "request",
            unit_count: 1,
            coverage_gaps: 0,
            input_tokens: 10,
            input_counted: 1,
            cached_tokens: 0,
            cached_counted: 1,
            uncached_tokens: 10,
            uncached_counted: 1,
            cache_write_tokens: 0,
            cache_write_counted: 1,
            output_tokens: 5,
            output_counted: 1,
            reasoning_tokens: 0,
            reasoning_counted: 1,
            accounting_basis: "debitmetre-audit-v1",
            source_version: "1",
          },
        ],
        quota_observations: [],
        balance_snapshots: [],
      }),
    });
    expect(codexPush.status, codexPush.body).toBe(200);

    const overviewResponse = await httpCall(`${webUrl}/api/v1/overview?tz=UTC&month=2026-11`);
    expect(overviewResponse.status, overviewResponse.body).toBe(200);
    const parsedOverview = overviewResponseSchema.safeParse(JSON.parse(overviewResponse.body));
    expect(parsedOverview.success, overviewResponse.body).toBe(true);
    if (!parsedOverview.success) {
      throw new Error("overview response did not match the shared schema");
    }
    const overview = parsedOverview.data;

    expect(overview.usage.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "codex",
          actor_kind: "machine",
          actor_id: "machine-a",
        }),
        expect.objectContaining({
          source: "opencode",
          actor_kind: "identity",
          actor_id: "laptop-key",
          accounting_basis: "orihsus-audit-v1",
        }),
      ]),
    );

    const fpA = overview.quotas.subjects.find((subject) => subject.account === "fp_a");
    const fpB = overview.quotas.subjects.find((subject) => subject.account === "fp_b");
    expect(fpA?.latest_valid?.windows.map((window) => window.slot)).toEqual(["rolling", "weekly"]);
    expect(fpB?.latest_valid?.windows.map((window) => window.slot)).toEqual([
      "rolling",
      "weekly",
      "monthly",
    ]);

    const usageHtml = renderToStaticMarkup(
      <UsageSection
        usage={overview.usage}
        daily={null}
        timezone="UTC"
        month="2026-11"
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );
    expect(usageHtml).toContain("Token usage breakdown");
    expect(usageHtml).toContain("Codex token usage by machine, model, and effort");
    expect(usageHtml).toContain("OpenCode Go token usage by identity, model, and effort");
    expect(usageHtml).toContain("machine-a");
    expect(usageHtml).toContain("laptop-key");
    expect(usageHtml).toContain(">Identity<");
    expect(usageHtml).toContain(">Machine<");

    if (!fpA) {
      throw new Error("fp_a quota subject missing");
    }
    const fpAHtml = renderToStaticMarkup(
      <QuotaSection quota={{ generated_at: overview.quotas.generated_at, subjects: [fpA] }} />,
    );
    expect(fpAHtml).toContain("Quota windows for OpenCode Go fp_a");
    expect(fpAHtml).toContain("rolling");
    expect(fpAHtml).toContain("43.5%");
    expect(fpAHtml).toContain("go-key-1");
    expect(fpAHtml).not.toContain("monthly");

    const quotaHtml = renderToStaticMarkup(<QuotaSection quota={overview.quotas} />);
    expect(quotaHtml).toContain("fp_b");
    expect(quotaHtml).toContain("monthly");
    expect(quotaHtml).not.toContain("No quota observations yet");
  });

  it("pushes AGY and Codex quota through local Workers, including late and same-second samples", async () => {
    if (ingest === null || web === null) {
      throw new Error("local Workers did not start");
    }
    const ingestUrl = baseUrl(ingest);
    const webUrl = baseUrl(web);
    const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const centrePath = path.join(tempDir, "telemetre-quota.sqlite3");
    const statePath = path.join(tempDir, "telemetre-state.json");

    let centre = new DatabaseSync(centrePath);
    centre.exec(CENTRE_SCHEMA);
    insertCentreSample(centre, {
      sampleId: "agy-main-1",
      provider: "agy",
      account: "agy-main",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:00:00Z",
      windows: [
        {
          groupName: "Gemini",
          bucketId: "five-hour",
          windowRaw: "5h",
          windowMinutes: 300,
          remainingValue: 0.4,
          remainingUnit: "fraction",
          remainingDisplay: 40,
          resetRaw: "2026-11-26T19:00:00Z",
          resetAt: "2026-11-26T19:00:00Z",
        },
        {
          groupName: "Gemini",
          bucketId: "weekly",
          windowRaw: "7d",
          windowMinutes: 10_080,
          remainingValue: 0.8,
          remainingUnit: "fraction",
          remainingDisplay: 80,
          resetRaw: "2026-12-03T00:00:00Z",
          resetAt: "2026-12-03T00:00:00Z",
        },
      ],
    });
    insertCentreSample(centre, {
      sampleId: "codex-main-1",
      provider: "codex",
      account: "codex-main",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:00:00Z",
      windows: [
        {
          groupName: "codex",
          bucketId: "primary",
          limitId: "codex",
          slot: "primary",
          windowRaw: 10_080,
          windowMinutes: 10_080,
          remainingValue: 10,
          remainingUnit: "percent_used",
          remainingDisplay: 90,
          resetRaw: 1_798_761_600,
          resetAt: "2026-12-01T00:00:00Z",
        },
      ],
    });
    insertCentreSample(centre, {
      sampleId: "agy-error-1",
      provider: "agy",
      account: "agy-error",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:01:00Z",
      status: "failure",
      errorKind: "timeout",
      errorDetail: "provider did not finish within 60s",
    });
    insertCentreSample(centre, {
      sampleId: "codex-empty-1",
      provider: "codex",
      account: "codex-empty",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:01:00Z",
      emptyWindows: true,
    });
    insertCentreSample(centre, {
      sampleId: "agy-future-1",
      provider: "agy",
      account: "agy-future",
      machine: "studio-a",
      sampledAt: "2099-01-01T00:00:00Z",
      receivedAt: "2026-11-26T14:02:00Z",
      timeAnomaly: true,
      windows: [
        {
          groupName: "Gemini",
          bucketId: "weekly",
          windowRaw: "7d",
          windowMinutes: 10_080,
          remainingValue: 0.01,
          remainingUnit: "fraction",
          remainingDisplay: 1,
          resetRaw: "2099-01-08T00:00:00Z",
          resetAt: "2099-01-08T00:00:00Z",
        },
      ],
    });
    centre.close();

    runTelemetre(python, centrePath, statePath, ingestUrl);

    // Insert after the first tick: an older late arrival and a same-second
    // replacement for each provider. A sampled_at cursor would drop these.
    centre = new DatabaseSync(centrePath);
    insertCentreSample(centre, {
      sampleId: "agy-late-1",
      provider: "agy",
      account: "agy-late",
      machine: "studio-a",
      sampledAt: "2026-11-26T13:30:00Z",
      receivedAt: "2026-11-26T14:05:00Z",
      windows: [
        {
          groupName: "Gemini",
          bucketId: "weekly",
          windowRaw: "7d",
          windowMinutes: 10_080,
          remainingValue: 0.6,
          remainingUnit: "fraction",
          remainingDisplay: 60,
          resetRaw: "2026-12-03T00:00:00Z",
          resetAt: "2026-12-03T00:00:00Z",
        },
      ],
    });
    insertCentreSample(centre, {
      sampleId: "codex-late-1",
      provider: "codex",
      account: "codex-late",
      machine: "studio-a",
      sampledAt: "2026-11-26T13:30:00Z",
      receivedAt: "2026-11-26T14:05:00Z",
      windows: [
        {
          groupName: "codex",
          bucketId: "primary",
          limitId: "codex",
          slot: "primary",
          windowRaw: 10_080,
          windowMinutes: 10_080,
          remainingValue: 30,
          remainingUnit: "percent_used",
          remainingDisplay: 70,
          resetRaw: 1_798_761_600,
          resetAt: "2026-12-01T00:00:00Z",
        },
      ],
    });
    insertCentreSample(centre, {
      sampleId: "agy-main-2",
      provider: "agy",
      account: "agy-main",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:00:00Z",
      receivedAt: "2026-11-26T14:05:00Z",
      windows: [
        {
          groupName: "Gemini",
          bucketId: "five-hour",
          windowRaw: "5h",
          windowMinutes: 300,
          remainingValue: 0.3,
          remainingUnit: "fraction",
          remainingDisplay: 30,
          resetRaw: "2026-11-26T19:00:00Z",
          resetAt: "2026-11-26T19:00:00Z",
        },
        {
          groupName: "Gemini",
          bucketId: "weekly",
          windowRaw: "7d",
          windowMinutes: 10_080,
          remainingValue: 0.5,
          remainingUnit: "fraction",
          remainingDisplay: 50,
          resetRaw: "2026-12-03T00:00:00Z",
          resetAt: "2026-12-03T00:00:00Z",
        },
      ],
    });
    insertCentreSample(centre, {
      sampleId: "codex-main-2",
      provider: "codex",
      account: "codex-main",
      machine: "studio-a",
      sampledAt: "2026-11-26T14:00:00Z",
      receivedAt: "2026-11-26T14:05:00Z",
      windows: [
        {
          groupName: "codex",
          bucketId: "primary",
          limitId: "codex",
          slot: "primary",
          windowRaw: 10_080,
          windowMinutes: 10_080,
          remainingValue: 20,
          remainingUnit: "percent_used",
          remainingDisplay: 80,
          resetRaw: 1_798_761_600,
          resetAt: "2026-12-01T00:00:00Z",
        },
      ],
    });
    centre.close();

    runTelemetre(python, centrePath, statePath, ingestUrl);

    const overviewResponse = await httpCall(`${webUrl}/api/v1/overview?tz=UTC&month=2026-11`);
    expect(overviewResponse.status, overviewResponse.body).toBe(200);
    const parsedOverview = overviewResponseSchema.safeParse(JSON.parse(overviewResponse.body));
    expect(parsedOverview.success, overviewResponse.body).toBe(true);
    if (!parsedOverview.success) {
      throw new Error("overview response did not match the shared schema");
    }
    const overview = parsedOverview.data;
    const subjectMap = new Map(
      overview.quotas.subjects.map((subject) => [
        `${subject.source}\u0000${subject.account}`,
        subject,
      ]),
    );

    const agyMain = subjectMap.get("agy\u0000agy-main");
    expect(agyMain?.latest_valid?.sample_id).toBe("agy-main-2");
    const agyWindows = new Map(
      (agyMain?.latest_valid?.windows ?? []).map((window) => [window.slot, window]),
    );
    expect(agyWindows.get("five-hour")).toMatchObject({
      bucket_id: "Gemini",
      label: "5h",
      used_percent: 70,
      remaining_percent: 30,
      window_duration_mins: 300,
    });
    expect(agyWindows.get("weekly")).toMatchObject({
      bucket_id: "Gemini",
      label: "7d",
      remaining_percent: 50,
    });

    const codexMain = subjectMap.get("codex\u0000codex-main");
    expect(codexMain?.latest_valid?.sample_id).toBe("codex-main-2");
    expect(codexMain?.latest_valid?.windows[0]).toMatchObject({
      bucket_id: "codex",
      slot: "primary",
      used_percent: 20,
      remaining_percent: 80,
    });

    // Late samples with older sampled_at values are still delivered and become
    // their own subjects instead of being skipped by a timestamp cursor.
    expect(subjectMap.get("agy\u0000agy-late")?.latest_valid).toMatchObject({
      sample_id: "agy-late-1",
      sampled_at: "2026-11-26T13:30:00Z",
    });
    expect(subjectMap.get("agy\u0000agy-late")?.latest_valid?.windows[0]?.remaining_percent).toBe(
      60,
    );
    expect(subjectMap.get("codex\u0000codex-late")?.latest_valid).toMatchObject({
      sample_id: "codex-late-1",
      sampled_at: "2026-11-26T13:30:00Z",
    });
    expect(
      subjectMap.get("codex\u0000codex-late")?.latest_valid?.windows[0]?.remaining_percent,
    ).toBe(70);

    const agyError = subjectMap.get("agy\u0000agy-error");
    expect(agyError?.latest_valid).toBeNull();
    expect(agyError?.latest_attempt).toMatchObject({
      status: "error",
      error_summary: "timeout: provider did not finish within 60s",
    });

    const codexEmpty = subjectMap.get("codex\u0000codex-empty");
    expect(codexEmpty?.latest_valid).toBeNull();
    expect(codexEmpty?.latest_attempt).toMatchObject({ status: "empty" });

    const agyFuture = subjectMap.get("agy\u0000agy-future");
    expect(agyFuture?.latest_valid).toBeNull();
    expect(agyFuture?.latest_attempt).toBeNull();
    expect(agyFuture?.anomalies[0]).toMatchObject({
      sample_id: "agy-future-1",
      sampled_at: "2099-01-01T00:00:00Z",
      time_anomaly: "future_sampled_at",
    });

    // AGY is quota-only: neither the CLI nor the overview may create AGY token
    // usage rows or a fake zero total.
    expect(overview.usage.rows.some((row) => row.source === "agy")).toBe(false);

    const quotaHtml = renderToStaticMarkup(<QuotaSection quota={overview.quotas} />);
    expect(quotaHtml).toContain("Quota windows for AGY agy-main");
    expect(quotaHtml).toContain("Quota windows for Codex codex-main");
    expect(quotaHtml).toContain("Gemini");
    expect(quotaHtml).toContain("five-hour");
    expect(quotaHtml).toContain("5h");
    expect(quotaHtml).toContain("30%");
    expect(quotaHtml).toContain("80%");
    expect(quotaHtml).toContain("Clock anomaly detected");
    expect(quotaHtml).toContain("future_sampled_at");
    expect(quotaHtml).toContain("Latest attempt failed");
    expect(quotaHtml).toContain("Latest attempt was empty");
    expect(quotaHtml).toContain("AGY tokens are not collected");
  });
});
