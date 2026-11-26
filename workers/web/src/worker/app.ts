import {
  DEFAULT_TIMEZONE,
  currentMonthInTimeZone,
  isValidMonth,
  isValidTimeZone,
} from "@bilan/shared";
import { Hono } from "hono";

import { getBalanceHistory, getOverview, getUsageDaily, isBalanceProvider } from "./queries";
import { quotaRoutes } from "./quota";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

interface UsageQuery {
  timezone: string;
  month: string;
}

function parseUsageQuery(context: {
  req: { query: (name: string) => string | undefined };
}): UsageQuery | null {
  const timezone = context.req.query("tz") ?? DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    return null;
  }
  const month = context.req.query("month") ?? currentMonthInTimeZone(new Date(), timezone);
  if (!isValidMonth(month)) {
    return null;
  }
  return { timezone, month };
}

app.get("/api/v1/overview", async (context) => {
  const usageQuery = parseUsageQuery(context);
  if (usageQuery === null) {
    return context.json({ error: "invalid_usage_query" }, 400);
  }
  const overview = await getOverview(context.env.DB, new Date(), usageQuery);
  context.header("cache-control", "no-store");
  return context.json(overview);
});

app.get("/api/v1/usage/daily", async (context) => {
  const usageQuery = parseUsageQuery(context);
  if (usageQuery === null) {
    return context.json({ error: "invalid_usage_query" }, 400);
  }
  const daily = await getUsageDaily(context.env.DB, usageQuery);
  context.header("cache-control", "no-store");
  return context.json(daily);
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

app.route("/", quotaRoutes);

app.get("/api/*", (context) => context.json({ error: "not_found" }, 404));

app.get("*", async (context) => {
  if (!context.env.ASSETS) {
    return context.text("Not found", 404);
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.notFound((context) => context.json({ error: "not_found" }, 404));
