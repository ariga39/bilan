import type { OverviewResponse } from "@bilan/shared";
import { ArrowRight, BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { monthLabel, sourceLabel, usagePeriod } from "@/lib/usage";
import type { DashboardSearch } from "../../search";
import { dashboardHref } from "../../search";

interface SourceRowSummary {
  key: string;
  source: string;
  requests: number;
  input: number | null;
  output: number | null;
  counted: number;
}

function summarizeBySource(overview: OverviewResponse): Array<SourceRowSummary> {
  const map = new Map<string, SourceRowSummary>();
  for (const row of overview.usage.rows) {
    const key = `${row.source}\u0000${row.accounting_basis}\u0000${row.unit_kind}`;
    const existing = map.get(key) ?? {
      key,
      source: row.source,
      requests: 0,
      input: null,
      output: null,
      counted: 0,
    };
    existing.requests += row.unit_count;
    existing.counted += row.input_counted;
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
  const period = usagePeriod(usage.month, usage.timezone, overview.generated_at);
  const next = { ...navigation, view: "usage" as const };
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
              href={dashboardHref(next)}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(next);
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
              const meteredPct =
                item.requests > 0 ? Math.round((item.counted / item.requests) * 1000) / 10 : null;
              return (
                <div
                  key={item.key}
                  className="min-w-0 rounded-xl border border-[#f5d08a]/20 bg-[#140f2c]/80 px-3.5 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{sourceLabel(item.source)}</span>
                    {meteredPct !== null && item.counted < item.requests ? (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title={`${formatNumber(item.counted)} of ${formatNumber(item.requests)} requests reported tokens`}
                      >
                        {meteredPct}% metered
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
                        title={item.input === null ? "Not reported" : formatNumber(item.input)}
                      >
                        {item.input === null ? "—" : formatCompactNumber(item.input)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">Output</dt>
                      <dd
                        className="truncate text-base font-semibold tabular-nums"
                        title={item.output === null ? "Not reported" : formatNumber(item.output)}
                      >
                        {item.output === null ? "—" : formatCompactNumber(item.output)}
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
