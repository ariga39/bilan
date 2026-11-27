import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 8788,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
      "~": path.resolve(__dirname, "src"),
    },
  },
  plugins: [
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: "../../.wrangler/state" },
    }),
    tanstackStart(),
    react(),
  ],
});
