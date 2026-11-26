import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "workers/web/dist/**",
    ".wrangler/**",
    "**/worker-configuration.d.ts",
  ],
});
