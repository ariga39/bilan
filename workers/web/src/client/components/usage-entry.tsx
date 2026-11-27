import type { OverviewResponse } from "@bilan/shared";
import { ArrowRight, BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { monthLabel, sourceLabel, usagePeriod } from "@/lib/usage";
import type { DashboardSearch } from "../../search";
import { usageHref } from "../../search";

interface SourceRowSummary {
  key: string;
  source: string;
  requests: number;
  gaps: number;
  input: number | null;
  inputCounted: number;
  output: number | null;
  outputCounted: number;
}

function summarizeBySource(overview: OverviewResponse): Array<SourceRowSummary> {
  const map = new Map<string, SourceRowSummary>();
  for (const row of overview.usage.rows) {
    const key = `${row.source}\u0000${row.accounting_basis}\u0000${row.unit_kind}`;
    const existing = map.get(key) ?? {
      key,
      source: row.source,
      requests: 0,
      gaps: 0,
      input: null,
      inputCounted: 0,
      output: null,
      outputCounted: 0,
    };
    existing.requests += row.unit_count;
    existing.gaps += row.coverage_gaps;
    existing.inputCounted += row.input_counted;
    existing.outputCounted += row.output_counted;
    if (row.input_tokens !== null) {
      existing.input = (existing.input ?? 0) + row.input_tokens;
    }
    if (row.output_tokens !== null) {
      existing.output = (existing.output ?? 0) + row.output_tokens;
    }
    map.set(key, existing);
  }
  return [...map.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function formatCoverageTag(counted: number, total: number): string {
  if (total <= 0) {
    return "";
  }
  if (total < 1000) {
    return `${formatNumber(counted)}/${formatNumber(total)}`;
  }
  return `${Math.round((counted / total) * 1000) / 10}%`;
}

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
  const summaries = summarizeBySource(overview);

  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <CardTitle
              style={{ fontFamily: "var(--font-display)" }}
              className="flex items-center gap-2 text-sm tracking-[0.08em] text-[#fef3c7]"
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
            className="rounded-full border-[#f5d08a]/35 bg-[#241c47] text-[#fef3c7] hover:bg-[#312661]"
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
              const reportedCounteds = [
                ...(item.input !== null ? [item.inputCounted] : []),
                ...(item.output !== null ? [item.outputCounted] : []),
              ];
              const minCounted =
                reportedCounteds.length > 0 ? Math.min(...reportedCounteds) : item.requests;
              const isPartial =
                (reportedCounteds.length > 0 && minCounted < item.requests) || item.gaps > 0;
              const meteredPct =
                item.requests > 0 ? Math.round((minCounted / item.requests) * 1000) / 10 : null;
              const inputPartial = item.input !== null && item.inputCounted < item.requests;
              const outputPartial = item.output !== null && item.outputCounted < item.requests;
              return (
                <div
                  key={item.key}
                  className="min-w-0 rounded-xl border border-[#f5d08a]/20 bg-[#140f2c]/80 px-3.5 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{sourceLabel(item.source)}</span>
                    {isPartial && meteredPct !== null ? (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title={`${formatNumber(minCounted)} of ${formatNumber(item.requests)} requests reported tokens${item.gaps > 0 ? ` (${formatNumber(item.gaps)} uncounted)` : ""}`}
                      >
                        {item.gaps > 0 && minCounted >= item.requests
                          ? `${formatNumber(item.gaps)} gap${item.gaps === 1 ? "" : "s"}`
                          : `${meteredPct}% metered`}
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
                          item.input === null
                            ? "Not reported"
                            : inputPartial
                              ? `${formatNumber(item.input)} (${formatNumber(item.inputCounted)}/${formatNumber(item.requests)} requests)`
                              : formatNumber(item.input)
                        }
                      >
                        {item.input === null ? "—" : formatCompactNumber(item.input)}
                        {inputPartial ? (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {formatCoverageTag(item.inputCounted, item.requests)}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">Output</dt>
                      <dd
                        className="truncate text-base font-semibold tabular-nums"
                        title={
                          item.output === null
                            ? "Not reported"
                            : outputPartial
                              ? `${formatNumber(item.output)} (${formatNumber(item.outputCounted)}/${formatNumber(item.requests)} requests)`
                              : formatNumber(item.output)
                        }
                      >
                        {item.output === null ? "—" : formatCompactNumber(item.output)}
                        {outputPartial ? (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {formatCoverageTag(item.outputCounted, item.requests)}
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
