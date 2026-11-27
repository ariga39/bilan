import type { OverviewResponse, UsageDailyResponse } from "@bilan/shared";

import { UsageSection } from "@/components/usage-section";
import type { DashboardSearch } from "../search";

export function UsageDashboard({
  search,
  overview,
  daily,
  dailyLoading = false,
  dailyError = null,
  refreshError = null,
  onTimezoneChange,
  onMonthChange,
}: {
  search: DashboardSearch;
  overview: OverviewResponse;
  daily: UsageDailyResponse | null;
  dailyLoading?: boolean;
  dailyError?: string | null;
  refreshError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
}) {
  const selectedDaily =
    daily && daily.timezone === search.tz && daily.month === search.month ? daily : null;

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
        timezone={search.tz}
        month={search.month}
        generatedAt={overview.generated_at}
        dailyLoading={dailyLoading}
        dailyError={dailyError}
        onTimezoneChange={onTimezoneChange}
        onMonthChange={onMonthChange}
      />
    </>
  );
}
