import type {
  OverviewResponse,
  UsageDailyResponse,
  UsageRangeResponse,
  UsageRangeWindow,
} from "@bilan/shared";

import { UsageSection } from "@/components/usage-section";
import type { DashboardSearch } from "../search";

export function UsageDashboard({
  search,
  overview,
  daily,
  range,
  dailyLoading = false,
  dailyError = null,
  rangeLoading = false,
  rangeError = null,
  refreshError = null,
  onTimezoneChange,
  onMonthChange,
  onWindowChange,
}: {
  search: DashboardSearch;
  overview: OverviewResponse;
  daily: UsageDailyResponse | null;
  range: UsageRangeResponse | null;
  dailyLoading?: boolean;
  dailyError?: string | null;
  rangeLoading?: boolean;
  rangeError?: string | null;
  refreshError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
  onWindowChange: (window: UsageRangeWindow) => void;
}) {
  const rangeWindow = search.range ?? "24h";
  const selectedDaily =
    daily && daily.timezone === search.tz && daily.month === search.month ? daily : null;
  const selectedRange =
    range && range.timezone === search.tz && range.window === rangeWindow ? range : null;

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
        usage={
          overview.usage.timezone === search.tz && overview.usage.month === search.month
            ? overview.usage
            : null
        }
        daily={selectedDaily}
        range={selectedRange}
        rangeWindow={rangeWindow}
        timezone={search.tz}
        month={search.month}
        generatedAt={overview.generated_at}
        dailyLoading={dailyLoading}
        dailyError={dailyError}
        rangeLoading={rangeLoading}
        rangeError={rangeError}
        onTimezoneChange={onTimezoneChange}
        onMonthChange={onMonthChange}
        onWindowChange={onWindowChange}
      />
    </>
  );
}
