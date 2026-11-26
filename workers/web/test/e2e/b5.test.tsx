import type { OverviewResponse, UsageDailyResponse } from "@bilan/shared";
import { overviewResponseSchema, usageDailyResponseSchema } from "@bilan/shared/schemas";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

import { BalanceCard } from "@/components/balance-card";
import { QuotaSection } from "@/components/quota-section";
import { UsageSection } from "@/components/usage-section";

type DevWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const MONTH = "2026-11";
const TIMEZONE = "UTC";

const DEBITMETRE_TOKEN = "b5-debitmetre-token";
const ORIHSUS_TOKEN = "b5-orihsus-token";
const TELEMETRE_TOKEN = "b5-telemetre-token";
const OPENROUTER_KEY = "b5-openrouter-key";
const DEEPSEEK_KEY = "b5-deepseek-key";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const PRODUCERS_JSON = JSON.stringify({
  "debitmetre-main": {
    token_sha256: sha256Hex(DEBITMETRE_TOKEN),
    display_name: "debitmetre (Codex usage)",
    expected_interval_seconds: 3600,
    scopes: [{ source: "codex", kind: "usage_buckets" }],
  },
  "orihsus-main": {
    token_sha256: sha256Hex(ORIHSUS_TOKEN),
    display_name: "orihsus (OpenCode Go)",
    expected_interval_seconds: 1800,
    scopes: [
      { source: "opencode", kind: "usage_buckets" },
      { source: "opencode", kind: "quota_observations" },
    ],
  },
  "telemetre-quota": {
    token_sha256: sha256Hex(TELEMETRE_TOKEN),
    display_name: "telemetre (AGY + Codex quota)",
    expected_interval_seconds: 1800,
    scopes: [
      { source: "agy", kind: "quota_observations" },
      { source: "codex", kind: "quota_observations" },
    ],
  },
});

interface RecordedCall {
  url: string;
  authorization: string | null;
  redirect?: string;
  status: number;
}

let tempDir = "";
let stateDir = "";
let hostDebitmetreDir = "";
let hostOrihsusDir = "";
let hostTelemetreDir = "";
let ingest: DevWorker | null = null;
let web: DevWorker | null = null;
let ingestBase = "";
let webBase = "";

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

function pythonCommand(): string {
  return process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

function runShipper(script: string, args: Array<string>, cwd: string): void {
  const result = spawnSync(pythonCommand(), [path.join(repoRoot, "shippers", script), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    timeout: 90_000,
  });
  requireSuccess(result, `real ${script}`);
}

function writeJsonl(file: string, records: Array<unknown>): void {
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function writeToken(directory: string, name: string, token: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, `${token}\n`);
  return file;
}

interface TokenUsage {
  input: number;
  cached: number;
  uncached: number;
  output: number;
  reasoning: number;
}

function debitmetreRecord(timestamp: string, eventId: string, usage: TokenUsage) {
  return {
    schema_version: 1,
    kind: "request",
    event_id: eventId,
    timestamp,
    machine_id: "machine-a",
    operation: "response",
    upstream_status: 200,
    outcome: "completed",
    model: "gpt-5",
    accounting_quality: "complete",
    metering_error: null,
    reasoning_effort: "high",
    usage: {
      input_total: usage.input,
      uncached: usage.uncached,
      cache_read: usage.cached,
      cache_write: 0,
      output_total: usage.output,
      reasoning: usage.reasoning,
      total: usage.input + usage.output,
    },
  };
}

function orihsusAuditRecord(timestamp: string, requestId: string, usage: TokenUsage) {
  return {
    timestamp,
    request_id: requestId,
    model: "deepseek-chat",
    key_fingerprint: "fp_a",
    gateway_key: "laptop-key",
    input_tokens: usage.input,
    cached_tokens: usage.cached,
    uncached_tokens: usage.uncached,
    cache_write_tokens: null,
    output_tokens: usage.output,
    reasoning_tokens: usage.reasoning,
    status: 200,
    outcome: "completed",
    latency_ms: 120,
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

function usageHistoryRecord(
  timestamp: string,
  fingerprint: string,
  rollingPercent: number,
  includeMonthly: boolean,
): UsageHistoryRecord {
  const record: UsageHistoryRecord = {
    timestamp,
    key_fingerprint: fingerprint,
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

function createHostFixtures(): void {
  hostDebitmetreDir = path.join(tempDir, "host-a-debitmetre");
  hostOrihsusDir = path.join(tempDir, "host-b-orihsus");
  hostTelemetreDir = path.join(tempDir, "host-c-telemetre");

  mkdirSync(hostDebitmetreDir, { recursive: true });
  mkdirSync(path.join(hostOrihsusDir, "usage"), { recursive: true });
  mkdirSync(hostTelemetreDir, { recursive: true });

  writeToken(hostDebitmetreDir, "token", DEBITMETRE_TOKEN);
  writeToken(hostOrihsusDir, "token", ORIHSUS_TOKEN);
  writeToken(hostTelemetreDir, "token", TELEMETRE_TOKEN);

  writeJsonl(path.join(hostDebitmetreDir, "usage.jsonl"), [
    debitmetreRecord("2026-11-26T14:05:00Z", "event-1", {
      input: 100,
      cached: 50,
      uncached: 40,
      output: 20,
      reasoning: 5,
    }),
    debitmetreRecord("2026-11-26T14:25:00Z", "event-2", {
      input: 200,
      cached: 80,
      uncached: 100,
      output: 40,
      reasoning: 10,
    }),
  ]);

  writeJsonl(path.join(hostOrihsusDir, "audit.jsonl"), [
    orihsusAuditRecord("2026-11-26T14:05:00Z", "request-1", {
      input: 100,
      cached: 40,
      uncached: 60,
      output: 20,
      reasoning: 4,
    }),
    orihsusAuditRecord("2026-11-26T14:15:00Z", "request-2", {
      input: 50,
      cached: 20,
      uncached: 30,
      output: 10,
      reasoning: 2,
    }),
  ]);
  writeJsonl(path.join(hostOrihsusDir, "usage", "2026-11-26.jsonl"), [
    usageHistoryRecord("2026-11-26T14:30:00Z", "fp_a", 42.5, false),
    usageHistoryRecord("2026-11-26T14:31:00Z", "fp_b", 90, true),
  ]);

  const fixture = path.join(repoRoot, "workers/web/test/e2e/fixtures/make-telemetre-db.py");
  const result = spawnSync(
    pythonCommand(),
    [fixture, "--database", path.join(hostTelemetreDir, "quota.sqlite3")],
    { cwd: hostTelemetreDir, encoding: "utf8", timeout: 30_000 },
  );
  requireSuccess(result, "synthetic telemetre database");
}

async function readOverview(webUrl: string): Promise<OverviewResponse> {
  const response = await httpCall(
    `${webUrl}/api/v1/overview?tz=${encodeURIComponent(TIMEZONE)}&month=${MONTH}`,
  );
  expect(response.status, response.body).toBe(200);
  const parsed = overviewResponseSchema.safeParse(JSON.parse(response.body));
  expect(parsed.success, response.body).toBe(true);
  if (!parsed.success) {
    throw new Error("overview response did not match the shared schema");
  }
  return parsed.data;
}

async function selectUpstreamFixture(
  ingestUrl: string,
  name: "v1" | "v2" | "redirect",
  at: string,
): Promise<void> {
  const response = await httpCall(
    `${ingestUrl}/__b5_fixture?name=${name}&at=${encodeURIComponent(at)}`,
  );
  expect(response.status, response.body).toBe(200);
  expect(response.body).toBe(name);
}

async function triggerScheduledPull(ingestUrl: string): Promise<void> {
  const response = await httpCall(`${ingestUrl}/__scheduled?cron=*/30+*+*+*+*`);
  expect(response.status, response.body).toBe(200);
}

function isRecordedCall(value: unknown): value is RecordedCall {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "authorization" in value &&
    (value.authorization === null || typeof value.authorization === "string") &&
    (!("redirect" in value) ||
      value.redirect === undefined ||
      typeof value.redirect === "string") &&
    "status" in value &&
    typeof value.status === "number"
  );
}

function isRecordedCalls(value: unknown): value is { calls: Array<RecordedCall> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "calls" in value &&
    Array.isArray(value.calls) &&
    value.calls.every(isRecordedCall)
  );
}

async function readRecordedCalls(ingestUrl: string, reset = false): Promise<Array<RecordedCall>> {
  const response = await httpCall(`${ingestUrl}/__b5_calls${reset ? "?reset=1" : ""}`);
  expect(response.status, response.body).toBe(200);
  const raw: unknown = JSON.parse(response.body);
  if (!isRecordedCalls(raw)) {
    throw new Error("recorded calls response has an unexpected shape");
  }
  return raw.calls;
}

async function readDaily(webUrl: string): Promise<UsageDailyResponse> {
  const response = await httpCall(
    `${webUrl}/api/v1/usage/daily?tz=${encodeURIComponent(TIMEZONE)}&month=${MONTH}`,
  );
  expect(response.status, response.body).toBe(200);
  const parsed = usageDailyResponseSchema.safeParse(JSON.parse(response.body));
  expect(parsed.success, response.body).toBe(true);
  if (!parsed.success) {
    throw new Error("daily usage response did not match the shared schema");
  }
  return parsed.data;
}

interface DebitmetreState {
  producer_id: string;
  batch_seq: number;
  cursor: number;
}

function readDebitmetreState(file: string): DebitmetreState {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("producer_id" in raw) ||
    typeof raw.producer_id !== "string" ||
    !("batch_seq" in raw) ||
    typeof raw.batch_seq !== "number" ||
    !("cursor" in raw) ||
    typeof raw.cursor !== "number"
  ) {
    throw new Error("debitmetre state file has an unexpected shape");
  }
  return {
    producer_id: raw.producer_id,
    batch_seq: raw.batch_seq,
    cursor: raw.cursor,
  };
}

beforeAll(async () => {
  if (!existsSync(path.join(repoRoot, "workers/web/dist/client"))) {
    throw new Error("Run `pnpm build` before the B5 acceptance E2E.");
  }

  tempDir = mkdtempSync(path.join(tmpdir(), "bilan-b5-e2e-"));
  stateDir = path.join(tempDir, "d1");
  createHostFixtures();

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
    ingest = await unstable_startWorker({
      entrypoint: path.join(repoRoot, "acceptance/ingest-b5-entry.ts"),
      config: path.join(repoRoot, "workers/ingest/wrangler.toml"),
      bindings: {
        INGEST_PRODUCERS_JSON: { type: "plain_text", value: PRODUCERS_JSON },
        OPENROUTER_API_KEY: { type: "plain_text", value: OPENROUTER_KEY },
        DEEPSEEK_API_KEY: { type: "plain_text", value: DEEPSEEK_KEY },
      },
      dev: {
        persist: stateDir,
        logLevel: "none",
        watch: false,
        inspector: false,
        server: { port: 0 },
        testScheduled: true,
      },
    });
    ingestBase = (await ingest.url).origin;

    web = await unstable_startWorker({
      entrypoint: path.join(repoRoot, "workers/web/src/worker/index.ts"),
      config: path.join(repoRoot, "workers/web/wrangler.toml"),
      dev: {
        persist: stateDir,
        logLevel: "none",
        watch: false,
        inspector: false,
        server: { port: 0 },
      },
    });
    webBase = (await web.url).origin;
  } catch (error) {
    await ingest?.dispose();
    await web?.dispose();
    ingest = null;
    web = null;
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await ingest?.dispose();
  await web?.dispose();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("B5 multi-host acceptance", () => {
  it("runs the real scheduled pull and all three shipper CLIs from separate host directories", async () => {
    if (ingest === null || web === null) {
      throw new Error("local Workers did not start");
    }
    const ingestUrl = ingestBase;
    const webUrl = webBase;

    // Zero manual-pull step: the production adapters run with only their
    // outbound transport replaced by synthetic HTTP responses.
    await selectUpstreamFixture(ingestUrl, "v1", "2026-11-26T14:00:00Z");
    await readRecordedCalls(ingestUrl, true);
    await triggerScheduledPull(ingestUrl);
    const firstPulled = await readOverview(webUrl);
    expect(
      firstPulled.balances.find((balance) => balance.provider === "openrouter")?.total_balance,
    ).toBe(37.5);
    expect(
      firstPulled.balances.find(
        (balance) => balance.provider === "deepseek" && balance.currency === "CNY",
      )?.total_balance,
    ).toBe(83.5);
    expect(
      firstPulled.balances.find(
        (balance) => balance.provider === "deepseek" && balance.currency === "USD",
      )?.total_balance,
    ).toBe(5);
    expect(
      firstPulled.balances.find((balance) => balance.provider === "deepseek")?.is_available,
    ).toBe(true);
    const firstCalls = await readRecordedCalls(ingestUrl);
    expect(firstCalls).toHaveLength(2);
    expect(firstCalls).toEqual(
      expect.arrayContaining([
        {
          url: "https://openrouter.ai/api/v1/credits",
          authorization: `Bearer ${OPENROUTER_KEY}`,
          redirect: "manual",
          status: 200,
        },
        {
          url: "https://api.deepseek.com/user/balance",
          authorization: `Bearer ${DEEPSEEK_KEY}`,
          redirect: "manual",
          status: 200,
        },
      ]),
    );

    // Changing only the synthetic HTTP responses must flow through the real
    // parser and calculations: OpenRouter total_balance = credits - usage, and
    // DeepSeek decimal strings are converted without losing currencies.
    await selectUpstreamFixture(ingestUrl, "v2", "2026-11-26T15:00:00Z");
    await readRecordedCalls(ingestUrl, true);
    await triggerScheduledPull(ingestUrl);
    const secondPulled = await readOverview(webUrl);
    const secondOpenRouter = secondPulled.balances.find(
      (balance) => balance.provider === "openrouter",
    );
    expect(secondOpenRouter?.total_balance).toBe(39.5);
    expect(secondOpenRouter?.cumulative_usage).toBe(20.5);
    expect(
      secondPulled.balances.find(
        (balance) => balance.provider === "deepseek" && balance.currency === "CNY",
      )?.total_balance,
    ).toBe(110);
    expect(
      secondPulled.balances.find(
        (balance) => balance.provider === "deepseek" && balance.currency === "USD",
      )?.total_balance,
    ).toBe(7.25);
    expect(
      secondPulled.balances.find((balance) => balance.provider === "deepseek")?.is_available,
    ).toBe(false);
    const secondCalls = await readRecordedCalls(ingestUrl);
    expect(secondCalls).toHaveLength(2);
    expect(secondCalls.every((call) => call.redirect === "manual")).toBe(true);

    // A 302 must fail through the adapter's non-ok path, never follow the
    // Location, and never send the Authorization header anywhere else.
    await selectUpstreamFixture(ingestUrl, "redirect", "2026-11-26T16:00:00Z");
    await readRecordedCalls(ingestUrl, true);
    await triggerScheduledPull(ingestUrl);
    const redirectCalls = await readRecordedCalls(ingestUrl);
    expect(redirectCalls).toHaveLength(2);
    expect(redirectCalls).toEqual(
      expect.arrayContaining([
        {
          url: "https://openrouter.ai/api/v1/credits",
          authorization: `Bearer ${OPENROUTER_KEY}`,
          redirect: "manual",
          status: 302,
        },
        {
          url: "https://api.deepseek.com/user/balance",
          authorization: `Bearer ${DEEPSEEK_KEY}`,
          redirect: "manual",
          status: 200,
        },
      ]),
    );
    expect(redirectCalls.some((call) => call.url.includes("redirect.invalid"))).toBe(false);
    const afterRedirect = await readOverview(webUrl);
    expect(
      afterRedirect.producers.find((producer) => producer.producer_id === "pull-openrouter"),
    ).toMatchObject({
      last_status: "error",
      last_error: "OpenRouter request failed (HTTP 302)",
    });
    expect(
      afterRedirect.balances.find((balance) => balance.provider === "openrouter")?.total_balance,
    ).toBe(39.5);

    // Return to a healthy fixture so later checks see successful producers.
    await selectUpstreamFixture(ingestUrl, "v2", "2026-11-26T17:00:00Z");
    await triggerScheduledPull(ingestUrl);

    runShipper(
      "debitmetre.py",
      [
        "--usage-file",
        path.join(hostDebitmetreDir, "usage.jsonl"),
        "--state-file",
        path.join(hostDebitmetreDir, "state.json"),
        "--producer-id",
        "debitmetre-main",
        "--endpoint",
        `${ingestUrl}/api/v1/ingest`,
        "--token-file",
        path.join(hostDebitmetreDir, "token"),
        "--timeout",
        "60",
      ],
      hostDebitmetreDir,
    );

    runShipper(
      "orihsus.py",
      [
        "--audit-file",
        path.join(hostOrihsusDir, "audit.jsonl"),
        "--usage-dir",
        path.join(hostOrihsusDir, "usage"),
        "--state-file",
        path.join(hostOrihsusDir, "state.json"),
        "--producer-id",
        "orihsus-main",
        "--endpoint",
        `${ingestUrl}/api/v1/ingest`,
        "--token-file",
        path.join(hostOrihsusDir, "token"),
        "--observer-machine",
        "host-b",
        "--interval-seconds",
        "300",
        "--timeout",
        "60",
      ],
      hostOrihsusDir,
    );

    runShipper(
      "telemetre.py",
      [
        "--database",
        path.join(hostTelemetreDir, "quota.sqlite3"),
        "--state-file",
        path.join(hostTelemetreDir, "state.json"),
        "--producer-id",
        "telemetre-quota",
        "--endpoint",
        `${ingestUrl}/api/v1/ingest`,
        "--token-file",
        path.join(hostTelemetreDir, "token"),
        "--timeout",
        "60",
      ],
      hostTelemetreDir,
    );

    const overview = await readOverview(webUrl);
    const daily = await readDaily(webUrl);

    expect(overview.producers.map((producer) => producer.producer_id).sort()).toEqual([
      "debitmetre-main",
      "orihsus-main",
      "pull-deepseek",
      "pull-openrouter",
      "telemetre-quota",
    ]);
    expect(overview.producers.every((producer) => producer.last_status === "ok")).toBe(true);

    const openRouter = overview.balances.find((balance) => balance.provider === "openrouter");
    const deepSeekCny = overview.balances.find(
      (balance) => balance.provider === "deepseek" && balance.currency === "CNY",
    );
    const deepSeekUsd = overview.balances.find(
      (balance) => balance.provider === "deepseek" && balance.currency === "USD",
    );
    expect(openRouter?.total_balance).toBe(39.5);
    expect(openRouter?.cumulative_usage).toBe(20.5);
    expect(deepSeekCny?.total_balance).toBe(110);
    expect(deepSeekUsd?.total_balance).toBe(7.25);
    expect(deepSeekCny?.is_available).toBe(false);

    const codexRow = overview.usage.rows.find(
      (row) =>
        row.source === "codex" &&
        row.actor_id === "machine-a" &&
        row.model === "gpt-5" &&
        row.effort === "high",
    );
    expect(codexRow).toMatchObject({
      actor_kind: "machine",
      accounting_basis: "debitmetre-audit-v1",
      unit_count: 2,
      input_tokens: 300,
      output_tokens: 60,
      is_partial: false,
    });

    const openCodeRow = overview.usage.rows.find(
      (row) => row.source === "opencode" && row.actor_id === "laptop-key",
    );
    expect(openCodeRow).toMatchObject({
      actor_kind: "identity",
      accounting_basis: "orihsus-audit-v1",
      unit_count: 2,
      input_tokens: 150,
      cached_tokens: 60,
      uncached_tokens: 90,
      output_tokens: 30,
      reasoning_tokens: 6,
      is_partial: true,
      partial_columns: ["cache_write_tokens"],
    });

    // Five v1 platforms are visible. AGY has quota only: no token-usage row and
    // no fabricated zero total.
    expect(overview.usage.rows.some((row) => row.source === "agy")).toBe(false);
    expect(JSON.stringify(overview.usage)).not.toContain("agy");
    expect(daily.rows.some((row) => row.source === "agy")).toBe(false);

    const agyQuota = overview.quotas.subjects.find(
      (subject) => subject.source === "agy" && subject.account === "personal",
    );
    expect(agyQuota?.latest_valid?.windows.map((window) => window.slot).sort()).toEqual([
      "five-hour",
      "weekly",
    ]);
    expect(
      agyQuota?.latest_valid?.windows.find((window) => window.slot === "five-hour")
        ?.remaining_percent,
    ).toBe(42);

    const codexQuota = overview.quotas.subjects.find(
      (subject) => subject.source === "codex" && subject.account === "work",
    );
    expect(codexQuota?.latest_valid?.windows.map((window) => window.slot).sort()).toEqual([
      "primary",
      "secondary",
    ]);

    const openCodeQuotaAccounts = overview.quotas.subjects
      .filter((subject) => subject.source === "opencode")
      .map((subject) => subject.account)
      .sort();
    expect(openCodeQuotaAccounts).toEqual(["fp_a", "fp_b"]);

    const usageHtml = renderToStaticMarkup(
      <UsageSection
        usage={overview.usage}
        daily={daily}
        timezone={TIMEZONE}
        month={MONTH}
        onTimezoneChange={() => undefined}
        onMonthChange={() => undefined}
      />,
    );
    expect(usageHtml).toContain("Codex token usage by machine, model, and effort");
    expect(usageHtml).toContain("OpenCode Go token usage by identity, model, and effort");
    expect(usageHtml).toContain("machine-a");
    expect(usageHtml).toContain("laptop-key");
    expect(usageHtml).not.toContain("AGY");
    expect(usageHtml).not.toContain("Antigravity");

    const quotaHtml = renderToStaticMarkup(<QuotaSection quota={overview.quotas} />);
    expect(quotaHtml).toContain("AGY");
    expect(quotaHtml).toContain("personal");
    expect(quotaHtml).toContain("Codex");
    expect(quotaHtml).toContain("OpenCode Go");
    expect(quotaHtml).toContain("fp_a");

    const balanceHtml = renderToStaticMarkup(
      <div>
        {overview.balances.map((balance) => (
          <BalanceCard key={`${balance.provider}-${balance.currency}`} balance={balance} />
        ))}
      </div>,
    );
    expect(balanceHtml).toContain("OpenRouter");
    expect(balanceHtml).toContain("DeepSeek");
  }, 120_000);

  it("migrates a collector with its copied log and state without double-counting", async () => {
    if (ingest === null || web === null) {
      throw new Error("local Workers did not start");
    }
    const ingestUrl = ingestBase;
    const webUrl = webBase;
    const oldStatePath = path.join(hostDebitmetreDir, "state.json");
    const oldState = readDebitmetreState(oldStatePath);
    expect(oldState.producer_id).toBe("debitmetre-main");
    expect(oldState.batch_seq).toBe(1);

    const migratedDir = path.join(tempDir, "host-d-debitmetre-migrated");
    cpSync(hostDebitmetreDir, migratedDir, { recursive: true });
    writeJsonl(path.join(migratedDir, "usage.jsonl"), [
      debitmetreRecord("2026-11-26T14:05:00Z", "event-1", {
        input: 100,
        cached: 50,
        uncached: 40,
        output: 20,
        reasoning: 5,
      }),
      debitmetreRecord("2026-11-26T14:25:00Z", "event-2", {
        input: 200,
        cached: 80,
        uncached: 100,
        output: 40,
        reasoning: 10,
      }),
      debitmetreRecord("2026-11-26T15:05:00Z", "event-3", {
        input: 300,
        cached: 120,
        uncached: 180,
        output: 60,
        reasoning: 15,
      }),
    ]);

    runShipper(
      "debitmetre.py",
      [
        "--usage-file",
        path.join(migratedDir, "usage.jsonl"),
        "--state-file",
        path.join(migratedDir, "state.json"),
        "--producer-id",
        "debitmetre-main",
        "--endpoint",
        `${ingestUrl}/api/v1/ingest`,
        "--token-file",
        path.join(migratedDir, "token"),
        "--timeout",
        "60",
      ],
      migratedDir,
    );

    const migratedState = readDebitmetreState(path.join(migratedDir, "state.json"));
    expect(migratedState.producer_id).toBe("debitmetre-main");
    expect(migratedState.batch_seq).toBe(oldState.batch_seq + 1);
    expect(migratedState.cursor).toBeGreaterThan(oldState.cursor);

    const overview = await readOverview(webUrl);
    const codexRows = overview.usage.rows.filter(
      (row) => row.source === "codex" && row.actor_id === "machine-a",
    );
    expect(codexRows).toHaveLength(1);
    expect(codexRows[0]).toMatchObject({
      accounting_basis: "debitmetre-audit-v1",
      unit_count: 3,
      input_tokens: 600,
      output_tokens: 120,
      is_partial: false,
    });
  }, 120_000);

  it("keeps read/write isolation, scoped tokens, and privacy boundaries intact", async () => {
    if (ingest === null || web === null) {
      throw new Error("local Workers did not start");
    }
    const ingestUrl = ingestBase;
    const webUrl = webBase;

    const webConfig = readFileSync(path.join(repoRoot, "workers/web/wrangler.toml"), "utf8");
    const ingestConfig = readFileSync(path.join(repoRoot, "workers/ingest/wrangler.toml"), "utf8");
    for (const config of [webConfig, ingestConfig]) {
      expect(config).toContain("workers_dev = false");
      expect(config).toContain("preview_urls = false");
    }
    expect(webConfig).not.toMatch(/OPENROUTER_API_KEY|DEEPSEEK_API_KEY|INGEST_PRODUCERS_JSON/);
    expect(ingestConfig).toContain('crons = ["*/30 * * * *"]');

    expect((await httpCall(`${webUrl}/api/v1/ingest`, { method: "POST" })).status).toBe(404);
    for (const route of ["/", "/api/v1/overview", "/api/v1/quotas"]) {
      expect((await httpCall(`${ingestUrl}${route}`)).status).toBe(404);
    }
    expect((await httpCall(`${webUrl}/api/v1/overview`)).status).toBe(200);

    const forbiddenQuota = await httpCall(`${ingestUrl}/api/v1/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEBITMETRE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        batch_seq: 900,
        usage_buckets: [],
        quota_observations: [
          {
            sample_id: "forbidden-agy",
            source: "agy",
            account: "personal",
            observer_machine: "host-a",
            sampled_at: "2026-11-26T14:00:00Z",
            interval_seconds: 900,
            status: "ok",
            time_anomaly: null,
            error_summary: null,
            windows: [],
          },
        ],
        balance_snapshots: [],
      }),
    });
    expect(forbiddenQuota.status, forbiddenQuota.body).toBe(403);

    const forbiddenUsage = await httpCall(`${ingestUrl}/api/v1/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TELEMETRE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        batch_seq: 901,
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
            input_tokens: 1,
            input_counted: 1,
            cached_tokens: 0,
            cached_counted: 1,
            uncached_tokens: 1,
            uncached_counted: 1,
            cache_write_tokens: 0,
            cache_write_counted: 1,
            output_tokens: 1,
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
    expect(forbiddenUsage.status, forbiddenUsage.body).toBe(403);

    const overview = await readOverview(webUrl);
    const serialized = JSON.stringify(overview);
    for (const secret of [
      DEBITMETRE_TOKEN,
      ORIHSUS_TOKEN,
      TELEMETRE_TOKEN,
      OPENROUTER_KEY,
      DEEPSEEK_KEY,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(overview.producers.every((producer) => producer.last_error === null)).toBe(true);
  }, 120_000);
});
