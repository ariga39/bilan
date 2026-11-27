import type { OverviewResponse } from "@bilan/shared";
import { ArrowRight, BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { monthLabel, sourceLabel, usagePeriod } from "@/lib/usage";
import {
  formatCoverageTag,
  isAggregatePartial,
  meteredCaption,
  overallCoverageBasis,
  summarizeUsageRows,
} from "@/lib/usage-summary";
import type { DashboardSearch } from "../../search";
import { usageHref } from "../../search";

export function UsageEntry({
  overview,
  navigation,
  onOpenUsage,
}: {
  overview: OverviewResponse;
  navigation: DashboardSearch;
  onOpenUsage: () => void;
}) {
  const usage = overview.usage;
  const period = usagePeriod(usage.month, usage.timezone, overview.generated_at);
  const summaries = summarizeUsageRows(usage.rows);

  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <CardTitle
              style={{ fontFamily: "var(--font-display)" }}
              className="flex items-center gap-2 text-sm tracking-[0.08em] text-starlight-parchment"
            >
              <span className="flex size-6 items-center justify-center rounded-full border border-pink-300/40 bg-pink-400/15 text-pink-200">
                <BarChart3 className="size-3.5" />
              </span>
              Token usage
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {period.isCurrentMonth ? "This month" : "Historical month"} ·{" "}
              {monthLabel(usage.month)}
              {period.isCurrentMonth ? ` · Today ${period.today}` : ""}
            </span>
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="rounded-full border-starlight-gold/35 bg-[#241c47] text-starlight-parchment hover:bg-[#312661]"
          >
            <a
              href={usageHref(navigation)}
              onClick={(event) => {
                event.preventDefault();
                onOpenUsage();
              }}
            >
              Open usage
              <ArrowRight className="size-3.5" />
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4">
        {summaries.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No token usage recorded for {monthLabel(usage.month)}.
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {summaries.map((item) => {
              const metered = meteredCaption(item.requests, item.gaps, [item.input, item.output], {
                includeGapsWhenPartial: false,
                mentionZeroGaps: false,
                basis: overallCoverageBasis(item.source),
              });
              const inputPartial = item.input.value !== null && isAggregatePartial(item.input);
              const outputPartial = item.output.value !== null && isAggregatePartial(item.output);
              return (
                <div
                  key={item.key}
                  className="min-w-0 rounded-xl border border-starlight-gold/20 bg-starlight-night/80 px-3.5 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{sourceLabel(item.source)}</span>
                    {metered ? (
                      <span className="text-[11px] text-muted-foreground" title={metered.title}>
                        {metered.text}
                      </span>
                    ) : null}
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">Requests</dt>
                      <dd
                        className="truncate text-base font-semibold tabular-nums"
                        title={formatNumber(item.requests)}
                      >
                        {formatCompactNumber(item.requests)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">Input</dt>
                      <dd
                        className="truncate text-base font-semibold tabular-nums"
                        title={
                          item.input.value === null
                            ? "Not reported"
                            : inputPartial
                              ? `${formatNumber(item.input.value)} (${formatNumber(item.input.counted)}/${formatNumber(item.requests)} requests)`
                              : formatNumber(item.input.value)
                        }
                      >
                        {item.input.value === null ? "—" : formatCompactNumber(item.input.value)}
                        {inputPartial ? (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {formatCoverageTag(item.input.counted, item.requests)}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">Output</dt>
                      <dd
                        className="truncate text-base font-semibold tabular-nums"
                        title={
                          item.output.value === null
                            ? "Not reported"
                            : outputPartial
                              ? `${formatNumber(item.output.value)} (${formatNumber(item.output.counted)}/${formatNumber(item.requests)} requests)`
                              : formatNumber(item.output.value)
                        }
                      >
                        {item.output.value === null ? "—" : formatCompactNumber(item.output.value)}
                        {outputPartial ? (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {formatCoverageTag(item.output.counted, item.requests)}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
