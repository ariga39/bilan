import { overviewResponseSchema } from "@bilan/shared/schemas";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev } from "wrangler";

import { QuotaSection } from "@/components/quota-section";
import { UsageSection } from "@/components/usage-section";

type DevWorker = Awaited<ReturnType<typeof unstable_dev>>;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const ORIHSUS_TOKEN = "test-orihsus-token";
const DEBITMETRE_TOKEN = "test-debitmetre-token";
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
  rolling: UsageWindowRecord;
  weekly: UsageWindowRecord;
  monthly?: UsageWindowRecord;
}

function usageRecord(
  timestamp: string,
  keyFingerprint: string,
  rollingPercent: number,
  includeMonthly: boolean,
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
  if (includeMonthly) {
    record.monthly = {
      status: "ok",
      percent: 30,
      resetsAt: "2026-12-31T00:00:00Z",
    };
  }
  return record;
}

beforeAll(async () => {
  if (!existsSync(path.join(repoRoot, "workers/web/dist/client"))) {
    throw new Error("Run `pnpm build` before `pnpm test:e2e`.");
  }

  tempDir = mkdtempSync(path.join(tmpdir(), "bilan-b3-e2e-"));
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

describe("B3 shipper to dashboard E2E", () => {
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
      usageRecord("2026-11-26T14:30:00.000Z", "fp_a", 42.5, true),
      usageRecord("2026-11-26T14:35:00.000Z", "fp_a", 43.5, false),
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
    expect(fpAHtml).not.toContain("monthly");

    const quotaHtml = renderToStaticMarkup(<QuotaSection quota={overview.quotas} />);
    expect(quotaHtml).toContain("fp_b");
    expect(quotaHtml).toContain("monthly");
    expect(quotaHtml).not.toContain("No quota observations yet");
  });
});
