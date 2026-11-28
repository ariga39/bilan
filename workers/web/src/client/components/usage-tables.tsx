import { ChevronDown, Layers } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { monthLabel, sourceLabel } from "@/lib/usage";
import type {
  MonthlyUsageGroup,
  NumberMode,
  TokenAggregate,
  UsageGroupFields,
} from "@/lib/usage-summary";
import {
  TOKEN_COLUMNS,
  aggregateTitle,
  formatCoverageTag,
  formatMetric,
  isAggregatePartial,
  meteredCaption,
  overallCoverageBasis,
} from "@/lib/usage-summary";
import { cn } from "@/lib/utils";

export function sourceAccent(source: string) {
  if (source === "codex") {
    return {
      dot: "bg-starlight-blush shadow-[0_0_8px_rgba(244,114,182,0.75)]",
      title: "text-starlight-codex",
      accentLine: "from-starlight-rose/60 via-starlight-violet/45 to-transparent",
    };
  }
  if (source === "opencode") {
    return {
      dot: "bg-starlight-amber shadow-[0_0_8px_rgba(252,211,77,0.75)]",
      title: "text-starlight-opencode",
      accentLine: "from-starlight-amber/60 via-starlight-opencode/45 to-transparent",
    };
  }
  return {
    dot: "bg-starlight-arcane shadow-[0_0_8px_rgba(192,132,252,0.75)]",
    title: "text-starlight-lilac",
    accentLine: "from-starlight-arcane/60 via-starlight-violet/40 to-transparent",
  };
}

function actorLabel(actorKind: string): string {
  if (actorKind === "identity") {
    return "Identity";
  }
  if (actorKind === "machine") {
    return "Machine";
  }
  return actorKind || "Actor";
}

function groupMeteredCaption(group: UsageGroupFields) {
  return meteredCaption(
    group.requests,
    group.gaps,
    [group.input, group.cached, group.output, group.reasoning],
    { basis: overallCoverageBasis(group.source) },
  );
}

export function TokenCell({ aggregate, mode }: { aggregate: TokenAggregate; mode: NumberMode }) {
  if (aggregate.value === null) {
    return (
      <span className="text-muted-foreground/70" title="Not reported" aria-label="Not reported">
        —
      </span>
    );
  }
  const isPartial = isAggregatePartial(aggregate);
  return (
    <span
      className="inline-flex max-w-full flex-wrap items-baseline gap-x-1 tabular-nums"
      title={aggregateTitle(aggregate)}
    >
      <span>{formatMetric(aggregate.value, mode)}</span>
      {isPartial ? (
        <span
          className="text-[10px] font-normal text-starlight-gold/80"
          aria-label={`${formatNumber(aggregate.counted)} of ${formatNumber(aggregate.units)} requests metered`}
        >
          {formatCoverageTag(aggregate.counted, aggregate.units)}
        </span>
      ) : null}
    </span>
  );
}

export function MonthlyDetailTable({
  group,
  mode,
}: {
  group: MonthlyUsageGroup;
  mode: NumberMode;
}) {
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-starlight-gold/15 bg-starlight-abyss/75">
      <table
        className="w-full text-xs sm:text-sm"
        aria-label={`Monthly detail for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-starlight-night/90 text-left text-[11px] uppercase tracking-wider text-starlight-gold/75">
          <tr>
            <th className="px-3 py-2.5 font-medium">
              {actorLabel(group.rows[0]?.actor_kind ?? "")}
            </th>
            <th className="px-3 py-2.5 font-medium">Model</th>
            <th className="px-3 py-2.5 font-medium">Effort</th>
            <th className="px-3 py-2.5 text-right font-medium">Requests</th>
            {TOKEN_COLUMNS.map((column) => (
              <th key={column.value} className="px-3 py-2.5 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr
              key={`${group.key}-${row.actor_kind}-${row.actor_id}-${row.model}-${row.effort}`}
              className="border-t border-starlight-gold/10 transition-colors hover:bg-starlight-violet/10"
            >
              <td className="px-3 py-2 font-medium text-starlight-mist">{row.actor_id}</td>
              <td className="px-3 py-2 font-mono text-xs text-starlight-parchment/95">
                {row.model}
              </td>
              <td className="px-3 py-2 text-xs">
                {row.effort === "" ? (
                  <span className="text-muted-foreground/70">—</span>
                ) : (
                  <span className="inline-flex rounded-full border border-starlight-gold/20 bg-starlight-night/80 px-2 py-0.5 text-[10px] font-medium text-starlight-lilac">
                    {row.effort}
                  </span>
                )}
              </td>
              <td
                className="px-3 py-2 text-right font-medium text-starlight-mist tabular-nums"
                title={formatNumber(row.unit_count)}
              >
                {formatMetric(row.unit_count, mode)}
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-2 text-right text-foreground/90">
                  <TokenCell
                    aggregate={{
                      value: row[column.value],
                      counted: row[column.counted],
                      units: row.unit_count,
                    }}
                    mode={mode}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MonthlyBreakdown({
  groups,
  month,
  mode,
  onMonthChange,
}: {
  groups: ReadonlyArray<MonthlyUsageGroup>;
  month: string;
  mode: NumberMode;
  onMonthChange: (month: string) => void;
}) {
  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-sm tracking-[0.1em] text-starlight-parchment sm:text-base"
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-violet-300/40 bg-violet-400/15 text-violet-200">
              <Layers className="size-3.5" aria-hidden="true" />
            </span>
            Monthly breakdown · {monthLabel(month)}
          </CardTitle>

          <div>
            <label className="sr-only" htmlFor="usage-month">
              Month
            </label>
            <input
              id="usage-month"
              aria-label="Month"
              type="month"
              className="h-8 rounded-full border border-starlight-gold/30 bg-starlight-night/90 px-3 text-xs text-foreground shadow-xs outline-none transition-colors [color-scheme:dark] hover:border-starlight-gold/50 focus-visible:ring-2 focus-visible:ring-ring"
              value={month}
              onChange={(event) => {
                if (event.target.value) {
                  onMonthChange(event.target.value);
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4">
        {groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-starlight-gold/20 bg-starlight-abyss/60 px-4 py-8 text-center">
            <p className="font-medium text-starlight-parchment">No token usage for this month</p>
          </div>
        ) : (
          <div className="space-y-3" role="group" aria-label="Monthly breakdown summary">
            {groups.map((group) => {
              const metered = groupMeteredCaption(group);
              const accent = sourceAccent(group.source);
              return (
                <div
                  key={group.key}
                  className="relative min-w-0 overflow-hidden rounded-xl border border-starlight-gold/18 bg-starlight-void/80"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-4 top-0 h-[2px] bg-gradient-to-r",
                      accent.accentLine,
                    )}
                  />
                  <details open className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3.5 py-3 transition-colors hover:bg-starlight-violet/10 [&::-webkit-details-marker]:hidden">
                      <div
                        className="flex min-w-0 items-center gap-2"
                        title={`${group.accountingBasis} · ${group.unitKind}`}
                      >
                        <ChevronDown
                          aria-hidden="true"
                          className="size-4 shrink-0 text-starlight-gold/75 transition-transform duration-200 group-open:rotate-180"
                        />
                        <span
                          aria-hidden="true"
                          className={cn("size-2 shrink-0 rounded-full", accent.dot)}
                        />
                        <span
                          style={{ fontFamily: "var(--font-display)" }}
                          className={cn("text-sm font-semibold tracking-wide", accent.title)}
                        >
                          {sourceLabel(group.source)}
                        </span>
                        {metered ? (
                          <span
                            className="rounded-full border border-starlight-gold/15 bg-starlight-abyss/70 px-2 py-0.5 text-[10px] text-starlight-violet-muted"
                            title={metered.title}
                          >
                            {metered.text}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="rounded-full border border-starlight-gold/15 bg-starlight-abyss/80 px-2.5 py-0.5"
                          title={formatNumber(group.requests)}
                        >
                          <strong className="font-semibold text-starlight-mist tabular-nums">
                            {formatMetric(group.requests, mode)}
                          </strong>{" "}
                          req
                        </span>
                        <span className="rounded-full border border-starlight-gold/15 bg-starlight-abyss/80 px-2.5 py-0.5">
                          In{" "}
                          <strong className="font-medium text-starlight-parchment">
                            <TokenCell aggregate={group.input} mode={mode} />
                          </strong>
                        </span>
                        <span className="rounded-full border border-starlight-gold/15 bg-starlight-abyss/80 px-2.5 py-0.5">
                          Out{" "}
                          <strong className="font-medium text-starlight-blush">
                            <TokenCell aggregate={group.output} mode={mode} />
                          </strong>
                        </span>
                      </div>
                    </summary>
                    <div className="border-t border-starlight-gold/12 px-3.5 pt-3 pb-3.5">
                      <MonthlyDetailTable group={group} mode={mode} />
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
