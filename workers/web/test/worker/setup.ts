import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

import type { Env as WorkerEnv } from "../../src/worker/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: Array<string> }>;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
