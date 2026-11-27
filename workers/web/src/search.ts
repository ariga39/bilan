import {
  DEFAULT_TIMEZONE,
  currentMonthInTimeZone,
  isValidMonth,
  isValidTimeZone,
} from "@bilan/shared";
import { z } from "zod";

export type DashboardView = "overview" | "usage";

export interface DashboardSearch {
  tz: string;
  month: string;
}

/** The overview route keeps `view` only to resolve legacy `/?view=usage` links. */
export interface OverviewSearch extends DashboardSearch {
  view?: "usage";
}

const rawSearchSchema = z.object({
  view: z.string().optional(),
  tz: z.string().optional(),
  month: z.string().optional(),
});

type RawSearch = z.infer<typeof rawSearchSchema>;

function normalizeSearch(raw: RawSearch): DashboardSearch {
  const tz = raw.tz !== undefined && isValidTimeZone(raw.tz) ? raw.tz : DEFAULT_TIMEZONE;
  const month =
    raw.month !== undefined && isValidMonth(raw.month)
      ? raw.month
      : currentMonthInTimeZone(new Date(), tz);
  return { tz, month };
}

export function validateDashboardSearch(search: unknown): DashboardSearch {
  return normalizeSearch(rawSearchSchema.parse(search));
}

export function validateOverviewSearch(search: unknown): OverviewSearch {
  const raw = rawSearchSchema.parse(search);
  const normalized = normalizeSearch(raw);
  return raw.view === "usage" ? { ...normalized, view: "usage" } : normalized;
}

function searchString(search: DashboardSearch): string {
  return new URLSearchParams({ tz: search.tz, month: search.month }).toString();
}

export function usageHref(search: DashboardSearch): string {
  return `/usage?${searchString(search)}`;
}
