import path from "node:path";

import react from "@vitejs/plugin-react";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(path.resolve(__dirname, "../../migrations"));

export default defineConfig({
  plugins: [
    react(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
    },
  },
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/worker/setup.ts"],
  },
});
