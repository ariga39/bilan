/**
 * Test-only ingest entry for the B5 multi-host acceptance run.
 *
 * Production adapters, their response parsing and balance calculations, the
 * scheduled orchestration, failure isolation, and D1 writes all run unchanged.
 * The only test seam is an explicit fetch implementation passed through
 * `runScheduledPulls`. It returns synthetic HTTP Response objects for the two
 * exact hard-coded upstream URLs, records the requested URL/headers/redirect
 * and response status, and throws for every other destination, so no network
 * request can leave the Worker.
 *
 * The test switches between small fixture versions through `/__b5_fixture` and
 * reads the recorded transport calls through `/__b5_calls`. RequestInit is
 * forwarded unchanged to the fixture response, but no real fetch is called.
 */

import worker from "../workers/ingest/src/index";
import { runScheduledPulls } from "../workers/ingest/src/scheduled";
import type { Env } from "../workers/ingest/src/types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/credits";
const DEEPSEEK_URL = "https://api.deepseek.com/user/balance";

type FixtureName = "v1" | "v2" | "redirect";

interface FixtureResponse {
  status: number;
  body?: unknown;
  location?: string;
}

interface FixtureSet {
  openRouter: FixtureResponse;
  deepSeek: FixtureResponse;
}

// These shapes follow the documented upstream APIs: OpenRouter
// GET /api/v1/credits returns data.total_credits/total_usage; DeepSeek
// GET /user/balance returns is_available plus balance_infos entries whose
// amount fields are decimal strings.
const FIXTURES: Record<FixtureName, FixtureSet> = {
  v1: {
    openRouter: {
      status: 200,
      body: { data: { total_credits: 50, total_usage: 12.5 } },
    },
    deepSeek: {
      status: 200,
      body: {
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "83.50",
            granted_balance: "3.50",
            topped_up_balance: "80.00",
          },
          {
            currency: "USD",
            total_balance: "5.00",
            granted_balance: "0.00",
            topped_up_balance: "5.00",
          },
        ],
      },
    },
  },
  v2: {
    openRouter: {
      status: 200,
      body: { data: { total_credits: 60, total_usage: 20.5 } },
    },
    deepSeek: {
      status: 200,
      body: {
        is_available: false,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "110.00",
            granted_balance: "10.00",
            topped_up_balance: "100.00",
          },
          {
            currency: "USD",
            total_balance: "7.25",
            granted_balance: "1.25",
            topped_up_balance: "6.00",
          },
        ],
      },
    },
  },
  redirect: {
    openRouter: {
      status: 302,
      location: "https://redirect.invalid/credential-leak",
    },
    deepSeek: {
      status: 200,
      body: {
        is_available: false,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "110.00",
            granted_balance: "10.00",
            topped_up_balance: "100.00",
          },
        ],
      },
    },
  },
};

interface RecordedCall {
  url: string;
  authorization: string | null;
  redirect: RequestInit["redirect"] | undefined;
  status: number;
}

let selectedFixture: FixtureName = "v1";
let selectedAt: number | null = null;
let recordedCalls: Array<RecordedCall> = [];

function isFixtureName(value: string | null): value is FixtureName {
  return value === "v1" || value === "v2" || value === "redirect";
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if ("url" in input) {
    return input.url;
  }
  return input.href;
}

function responseFor(spec: FixtureResponse): Response {
  if (spec.body === undefined) {
    const init: ResponseInit = { status: spec.status };
    if (spec.location !== undefined) {
      init.headers = { location: spec.location };
    }
    return new Response(null, init);
  }
  return new Response(JSON.stringify(spec.body), {
    status: spec.status,
    headers: { "content-type": "application/json" },
  });
}

const fixtureFetch: typeof fetch = async (input, init) => {
  const url = requestUrl(input);
  const fixture = FIXTURES[selectedFixture];
  const spec =
    url === OPENROUTER_URL ? fixture.openRouter : url === DEEPSEEK_URL ? fixture.deepSeek : null;
  const authorization = new Headers(init?.headers).get("authorization");
  if (spec === null) {
    recordedCalls.push({ url, authorization, redirect: init?.redirect, status: 0 });
    throw new Error(`refusing unexpected outbound fetch: ${url}`);
  }
  recordedCalls.push({ url, authorization, redirect: init?.redirect, status: spec.status });
  return responseFor(spec);
};

type B5Env = Env;

export default {
  ...worker,
  async fetch(request: Request, env: B5Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__b5_fixture") {
      const name = url.searchParams.get("name");
      if (!isFixtureName(name)) {
        return new Response("unknown fixture", { status: 400 });
      }
      selectedFixture = name;
      const at = url.searchParams.get("at");
      selectedAt = at === null ? null : Date.parse(at);
      if (selectedAt !== null && !Number.isFinite(selectedAt)) {
        return new Response("invalid at timestamp", { status: 400 });
      }
      return new Response(name);
    }
    if (url.pathname === "/__b5_calls") {
      if (url.searchParams.get("reset") === "1") {
        recordedCalls = [];
      }
      return new Response(JSON.stringify({ calls: recordedCalls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: B5Env): Promise<void> {
    await runScheduledPulls(
      {
        scheduledTime: selectedAt ?? controller.scheduledTime,
        cron: controller.cron,
        noRetry() {},
      },
      env,
      fixtureFetch,
    );
  },
};
