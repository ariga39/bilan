import { ChevronDown, Layers } from "lucide-react";

import { SectionLabel } from "@/components/dashboard-shell";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { sourceLabel } from "@/lib/usage";
import type {
  DailyUsageGroup,
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

export function Summary({
  groups,
  label,
  mode,
  compact = false,
}: {
  groups: ReadonlyArray<UsageGroupFields>;
  label: string;
  mode: NumberMode;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("grid gap-3.5", groups.length > 1 && "lg:grid-cols-2")}
    >
      {groups.map((group) => {
        const metered = groupMeteredCaption(group);
        const accent = sourceAccent(group.source);
        return (
          <Card
            key={group.key}
            className={cn("min-w-0 gap-0 overflow-hidden", compact ? "py-3.5" : "py-4")}
          >
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-6 top-0 h-[2px] bg-gradient-to-r",
                accent.accentLine,
              )}
            />
            <CardContent className="space-y-3 px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  className="flex min-w-0 items-center gap-2"
                  title={`${group.accountingBasis} · ${group.unitKind}`}
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2 shrink-0 rounded-full", accent.dot)}
                  />
                  <h3
                    style={{ fontFamily: "var(--font-display)" }}
                    className={cn("truncate text-sm font-semibold tracking-wide", accent.title)}
                  >
                    {sourceLabel(group.source)}
                  </h3>
                </div>
                {metered ? (
                  <span
                    className="rounded-full border border-starlight-gold/20 bg-starlight-void/80 px-2 py-0.5 text-[11px] text-starlight-violet-muted"
                    title={metered.title}
                  >
                    {metered.text}
                  </span>
                ) : null}
              </div>

              <dl className="grid grid-cols-3 gap-2.5">
                <div className="min-w-0 rounded-xl border border-starlight-gold/15 bg-starlight-void/80 px-3 py-2">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Requests
                  </dt>
                  <dd
                    className={cn(
                      "mt-0.5 wrap-anywhere font-bold tracking-tight text-starlight-mist tabular-nums",
                      compact ? "text-lg sm:text-xl" : "text-xl sm:text-2xl",
                    )}
                    title={formatNumber(group.requests)}
                  >
                    {formatMetric(group.requests, mode)}
                  </dd>
                </div>

                <div className="min-w-0 rounded-xl border border-starlight-gold/15 bg-starlight-void/80 px-3 py-2">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Input
                  </dt>
                  <dd
                    className={cn(
                      "mt-0.5 wrap-anywhere font-semibold text-starlight-parchment",
                      compact ? "text-base sm:text-lg" : "text-lg sm:text-xl",
                    )}
                  >
                    <TokenCell aggregate={group.input} mode={mode} />
                  </dd>
                </div>

                <div className="min-w-0 rounded-xl border border-starlight-gold/15 bg-starlight-void/80 px-3 py-2">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Output
                  </dt>
                  <dd
                    className={cn(
                      "mt-0.5 wrap-anywhere font-semibold text-starlight-blush",
                      compact ? "text-base sm:text-lg" : "text-lg sm:text-xl",
                    )}
                  >
                    <TokenCell aggregate={group.output} mode={mode} />
                  </dd>
                </div>
              </dl>

              <dl className="grid grid-cols-2 gap-2 rounded-xl border border-starlight-gold/10 bg-starlight-abyss/70 px-3 py-2 text-xs">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                  <dt className="text-[11px] text-muted-foreground">Cached</dt>
                  <dd className="min-w-0 wrap-anywhere font-medium text-starlight-teal-soft">
                    <TokenCell aggregate={group.cached} mode={mode} />
                  </dd>
                </div>
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 border-l border-starlight-gold/12 pl-2.5">
                  <dt className="text-[11px] text-muted-foreground">Reasoning</dt>
                  <dd className="min-w-0 wrap-anywhere font-medium text-starlight-lilac">
                    <TokenCell aggregate={group.reasoning} mode={mode} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function DailyDetailTable({ group, mode }: { group: DailyUsageGroup; mode: NumberMode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-starlight-gold/15 bg-starlight-abyss/75">
      <table
        className="w-full text-xs sm:text-sm"
        aria-label={`Daily exact values for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-starlight-night/90 text-left text-[11px] uppercase tracking-wider text-starlight-gold/75">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            {TOKEN_COLUMNS.map((column) => (
              <th key={column.value} className="px-3 py-2 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr
              key={`${group.key}-${row.date}`}
              className="border-t border-starlight-gold/10 transition-colors hover:bg-starlight-violet/10"
            >
              <td className="px-3 py-2 font-mono text-xs text-starlight-violet-muted">
                {row.date}
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
  mode,
}: {
  groups: ReadonlyArray<MonthlyUsageGroup>;
  mode: NumberMode;
}) {
  return (
    <section className="min-w-0">
      <SectionLabel icon={Layers} title="Breakdown" />
      {groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-starlight-gold/20 bg-starlight-dusk/55 px-4 py-6 text-center text-sm text-muted-foreground">
          No breakdown rows for this month.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const metered = groupMeteredCaption(group);
            const accent = sourceAccent(group.source);
            return (
              <Card key={group.key} className="min-w-0 gap-0 overflow-hidden py-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3.5 transition-colors hover:bg-starlight-violet/10 [&::-webkit-details-marker]:hidden">
                    <div className="flex min-w-0 items-center gap-2.5">
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
                      <span className="rounded-full border border-starlight-gold/15 bg-starlight-void/80 px-2 py-0.5 text-[11px] text-muted-foreground">
                        {group.rows.length} {group.rows.length === 1 ? "row" : "rows"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className="rounded-full border border-starlight-gold/15 bg-starlight-void/80 px-2.5 py-0.5 font-medium text-starlight-mist tabular-nums"
                        title={formatNumber(group.requests)}
                      >
                        {formatMetric(group.requests, mode)} req
                      </span>
                      {metered ? (
                        <span
                          className="rounded-full border border-starlight-gold/15 bg-starlight-abyss/70 px-2 py-0.5 text-[11px] text-starlight-violet-muted"
                          title={metered.title}
                        >
                          {metered.text}
                        </span>
                      ) : null}
                    </div>
                  </summary>
                  <div className="border-t border-starlight-gold/12 px-4 pt-3 pb-4">
                    <MonthlyDetailTable group={group} mode={mode} />
                  </div>
                </details>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
