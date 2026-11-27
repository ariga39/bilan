import type { OverviewResponse } from "@bilan/shared";
import { ArrowRight, BarChart3, Clock3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/format";
import type { DashboardSearch } from "../../search";
import { dashboardHref } from "../../search";

function sourceLabel(source: string): string {
  if (source === "codex") {
    return "Codex";
  }
  if (source === "opencode") {
    return "OpenCode Go";
  }
  return source;
}

export function UsageEntry({
  overview,
  navigation,
  onNavigate,
}: {
  overview: OverviewResponse;
  navigation: DashboardSearch;
  onNavigate: (navigation: DashboardSearch) => void;
}) {
  const usage = overview.usage;
  const next = { ...navigation, view: "usage" as const };
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="size-4 text-muted-foreground" />
          Token usage
        </CardTitle>
        <CardDescription>
          Open today&apos;s and this month&apos;s requests, tokens, and coverage on the usage view.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1 text-sm">
          <p>
            {usage.month} · {usage.timezone}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" />
            {usage.latest_bucket_start === null
              ? "No usage bucket for this selection."
              : `Latest bucket ${formatDateTime(usage.latest_bucket_start)} · ${formatAge(
                  usage.data_age_seconds,
                )}`}
          </p>
          {usage.source_freshness.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {usage.source_freshness.map((source) => (
                <span
                  key={source.source}
                  className="rounded-full border bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {sourceLabel(source.source)} · {formatAge(source.data_age_seconds)}
                  {source.is_stale ? " · delayed" : ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <Button asChild variant="outline">
          <a
            href={dashboardHref(next)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(next);
            }}
          >
            Open usage
            <ArrowRight />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
