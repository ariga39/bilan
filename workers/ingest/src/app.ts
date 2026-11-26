import { Hono } from "hono";

import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

app.all("*", (context) => context.json({ error: "not_found" }, 404));
