import type { MonthlyUsage, UsageRangeResponse, UsageRangeWindow } from "@bilan/shared";
import { BarChart3, Clock3, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatAge } from "@/lib/format";
import { sourceLabel } from "@/lib/usage";
import type { NumberMode } from "@/lib/usage-summary";
import { groupMonthlyRows } from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

import { RollingUsageSection } from "./usage-range";
import { MonthlyBreakdown, sourceAccent } from "./usage-tables";

const TIMEZONES = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "America/New_York", label: "America/New_York" },
];

const CONTROL_CLASS =
  "h-8 rounded-full border border-starlight-gold/30 bg-starlight-night/90 px-3 text-xs text-foreground shadow-xs outline-none transition-colors [color-scheme:dark] hover:border-starlight-gold/50 focus-visible:ring-2 focus-visible:ring-ring";

function SourceFreshness({ usage }: { usage: MonthlyUsage }) {
  if (usage.source_freshness.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {usage.source_freshness.map((source) => {
        const accent = sourceAccent(source.source);
        return (
          <span
            key={source.source}
            aria-label={`${sourceLabel(source.source)} freshness`}
            className="inline-flex items-center gap-1.5 rounded-full border border-starlight-gold/18 bg-starlight-abyss/80 px-2.5 py-0.5 text-[11px] text-starlight-violet-muted"
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", accent.dot)} />
            <Clock3 className="size-3 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground/90">{sourceLabel(source.source)}</span>
            <span className="text-muted-foreground">
              {source.latest_bucket_start
                ? ` · ${formatAge(source.data_age_seconds)}`
                : " · no data"}
            </span>
            {source.is_stale ? (
              <Badge
                variant="outline"
                className="rounded-full border-amber-400/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-200"
              >
                Delayed
              </Badge>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function UsageSection({
  usage,
  range = null,
  rangeWindow,
  timezone,
  month,
  isUpdating = false,
  rangeLoading = false,
  rangeUpdating = false,
  rangeError = null,
  onTimezoneChange,
  onMonthChange,
  onWindowChange,
}: {
  usage: MonthlyUsage | null;
  range?: UsageRangeResponse | null;
  rangeWindow?: UsageRangeWindow;
  timezone: string;
  month: string;
  isUpdating?: boolean;
  rangeLoading?: boolean;
  rangeUpdating?: boolean;
  rangeError?: string | null;
  onTimezoneChange: (timezone: string) => void;
  onMonthChange: (month: string) => void;
  onWindowChange?: (window: UsageRangeWindow) => void;
}) {
  const [numberMode, setNumberMode] = useState<NumberMode>("compact");
  const timezoneOptions = TIMEZONES.some((option) => option.value === timezone)
    ? TIMEZONES
    : [{ value: timezone, label: timezone }, ...TIMEZONES];
  const attributionApproximate =
    usage?.bucket_attribution === "approximate" || range?.bucket_attribution === "approximate";
  const attributionNote = usage?.bucket_attribution_note ?? range?.bucket_attribution_note;
  const monthGroups = usage ? groupMonthlyRows(usage.rows) : [];

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-starlight-gold/22 bg-starlight-void/80 px-4 py-3 backdrop-blur-md">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-sm font-semibold tracking-[0.1em] text-starlight-parchment sm:text-base"
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-pink-300/40 bg-pink-400/15 text-pink-200">
              <BarChart3 className="size-3.5" aria-hidden="true" />
            </span>
            Token usage
          </h2>
          {usage ? <SourceFreshness usage={usage} /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Number format"
            className="inline-flex h-8 items-center rounded-full border border-starlight-gold/30 bg-starlight-night/90 p-0.5 text-xs"
          >
            <button
              type="button"
              aria-pressed={numberMode === "compact"}
              className={cn(
                "rounded-full px-2.5 py-0.5 transition-all",
                numberMode === "compact"
                  ? "bg-gradient-to-r from-starlight-rose to-starlight-violet font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setNumberMode("compact");
              }}
            >
              Compact
            </button>
            <button
              type="button"
              aria-pressed={numberMode === "exact"}
              className={cn(
                "rounded-full px-2.5 py-0.5 transition-all",
                numberMode === "exact"
                  ? "bg-gradient-to-r from-starlight-rose to-starlight-violet font-medium text-white shadow-[0_0_12px_rgba(244,114,182,0.45)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setNumberMode("exact");
              }}
            >
              Exact
            </button>
          </div>

          <label className="sr-only" htmlFor="usage-timezone">
            Timezone
          </label>
          <select
            id="usage-timezone"
            aria-label="Timezone"
            className={CONTROL_CLASS}
            value={timezone}
            onChange={(event) => {
              onTimezoneChange(event.target.value);
            }}
          >
            {timezoneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {attributionApproximate ? (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-400/35 bg-amber-500/12 px-3.5 py-2.5 text-xs text-amber-200"
          role="status"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="leading-relaxed">
            <span className="font-semibold text-amber-100">Approximate bucket boundaries. </span>
            {attributionNote}
          </p>
        </div>
      ) : null}

      {rangeWindow && onWindowChange ? (
        <RollingUsageSection
          range={range}
          window={rangeWindow}
          mode={numberMode}
          loading={rangeLoading}
          updating={rangeUpdating}
          error={rangeError}
          onWindowChange={onWindowChange}
        />
      ) : null}

      {usage === null ? (
        <Card className="border-dashed py-8 text-center">
          <CardContent className="px-4">
            <p className="font-medium text-starlight-parchment">Usage could not be loaded</p>
          </CardContent>
        </Card>
      ) : (
        <div className={cn("min-w-0 transition-opacity duration-150", isUpdating && "opacity-65")}>
          <MonthlyBreakdown
            groups={monthGroups}
            month={month}
            mode={numberMode}
            onMonthChange={onMonthChange}
          />
        </div>
      )}
    </div>
  );
}
