import {
  DEFAULT_TIMEZONE,
  currentMonthInTimeZone,
  isValidMonth,
  isValidTimeZone,
} from "@bilan/shared";
import { z } from "zod";

export const DASHBOARD_VIEWS = ["overview", "usage"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export interface DashboardSearch {
  view: DashboardView;
  tz: string;
  month: string;
}

const rawSearchSchema = z.object({
  view: z.string().optional(),
  tz: z.string().optional(),
  month: z.string().optional(),
});

export function validateDashboardSearch(search: unknown): DashboardSearch {
  const raw = rawSearchSchema.parse(search);
  const tz = raw.tz !== undefined && isValidTimeZone(raw.tz) ? raw.tz : DEFAULT_TIMEZONE;
  const month =
    raw.month !== undefined && isValidMonth(raw.month)
      ? raw.month
      : currentMonthInTimeZone(new Date(), tz);
  const view = raw.view === "usage" ? "usage" : "overview";
  return { view, tz, month };
}

export function dashboardHref(search: DashboardSearch): string {
  const query = new URLSearchParams({
    view: search.view,
    tz: search.tz,
    month: search.month,
  });
  return `/?${query.toString()}`;
}
