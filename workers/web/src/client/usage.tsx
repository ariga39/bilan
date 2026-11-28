import type { OverviewResponse, UsageRangeResponse, UsageRangeWindow } from "@bilan/shared";

import { UsageSection } from "@/components/usage-section";
import type { DashboardSearch } from "../search";

export function UsageDashboard({
  search,
  overview,
  range,
  overviewUpdating = false,
  rangeLoading = false,
  rangeUpdating = false,
  rangeError = null,
  refreshError = null,
  onTimezoneChange,
  onMonthChange,
  onWindowChange,
}: {
  search: DashboardSearch;
  overview: OverviewResponse;
  range: UsageRangeResponse | null;
  overviewUpdating?: boolean;
  rangeLoading?: boolean;
  rangeUpdating?: boolean;
  rangeError?: string | null;
  refreshError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
  onWindowChange: (window: UsageRangeWindow) => void;
}) {
  const rangeWindow = search.range ?? "24h";
  const selectedUsage =
    (overview.usage.timezone === search.tz && overview.usage.month === search.month) ||
    overviewUpdating
      ? overview.usage
      : null;
  const selectedRange =
    range && ((range.timezone === search.tz && range.window === rangeWindow) || rangeUpdating)
      ? range
      : null;

  return (
    <>
      {refreshError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {refreshError}
        </div>
      ) : null}

      <UsageSection
        usage={selectedUsage}
        range={selectedRange}
        rangeWindow={rangeWindow}
        timezone={search.tz}
        month={search.month}
        isUpdating={overviewUpdating}
        rangeLoading={rangeLoading}
        rangeUpdating={rangeUpdating}
        rangeError={rangeError}
        onTimezoneChange={onTimezoneChange}
        onMonthChange={onMonthChange}
        onWindowChange={onWindowChange}
      />
    </>
  );
}
