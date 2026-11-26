import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(path.resolve(__dirname, "../../migrations"));

const producers = JSON.stringify({
  "debitmetre-main": {
    token_sha256: "c6c726663d39185c46966f2075416a8b8348523b809c7e09f1ea984631e98a9b",
    display_name: "debitmetre (Codex usage)",
    expected_interval_seconds: 3600,
    scopes: [{ source: "codex", kind: "usage_buckets" }],
  },
  "other-main": {
    token_sha256: "cf2eb6ac53daa504ef573b47bb3b5298fb2f7b45742a067774b5d257afead772",
    display_name: "other shipper",
    expected_interval_seconds: 3600,
    scopes: [{ source: "opencode", kind: "usage_buckets" }],
  },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          OPENROUTER_API_KEY: "test-openrouter-key",
          DEEPSEEK_API_KEY: "test-deepseek-key",
          INGEST_PRODUCERS_JSON: producers,
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
