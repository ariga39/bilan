import { Hono } from "hono";

import { handleIngest } from "./ingest";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

app.post("/api/v1/ingest", async (context) => {
  const result = await handleIngest(context.req.raw, context.env);
  context.header("cache-control", "no-store");
  return context.json(result.body, result.status);
});

app.all("*", (context) => context.json({ error: "not_found" }, 404));
