import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  // Worker globals and the split DOM/Worker tsconfigs are not visible to the
  // type-aware lint backend in this repo; `pnpm typecheck` enforces types.
  options: { typeAware: false, reportUnusedDisableDirectives: "error" },
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "workers/web/dist/**",
    ".wrangler/**",
    "**/worker-configuration.d.ts",
  ],
});
