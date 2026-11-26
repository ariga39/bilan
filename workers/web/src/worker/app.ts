import { Hono } from "hono";

import { getBalanceHistory, getOverview, isBalanceProvider } from "./queries";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/overview", async (context) => {
  const overview = await getOverview(context.env.DB);
  context.header("cache-control", "no-store");
  return context.json(overview);
});

app.get("/api/v1/balances/history", async (context) => {
  const provider = context.req.query("provider");
  if (!isBalanceProvider(provider)) {
    return context.json({ error: "invalid_provider" }, 400);
  }

  const daysRaw = context.req.query("days") ?? "30";
  if (!/^\d+$/u.test(daysRaw)) {
    return context.json({ error: "invalid_days" }, 400);
  }

  const days = Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return context.json({ error: "invalid_days" }, 400);
  }

  const history = await getBalanceHistory(context.env.DB, provider, days);
  context.header("cache-control", "no-store");
  return context.json(history);
});

app.get("/api/*", (context) => context.json({ error: "not_found" }, 404));

app.get("*", async (context) => {
  if (!context.env.ASSETS) {
    return context.text("Not found", 404);
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.notFound((context) => context.json({ error: "not_found" }, 404));
