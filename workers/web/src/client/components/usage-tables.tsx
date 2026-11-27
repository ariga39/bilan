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
      <span className="text-muted-foreground" title="Not reported" aria-label="Not reported">
        —
      </span>
    );
  }
  const isPartial = isAggregatePartial(aggregate);
  return (
    <span
      className="inline-flex items-baseline gap-1 tabular-nums"
      title={aggregateTitle(aggregate)}
    >
      <span>{formatMetric(aggregate.value, mode)}</span>
      {isPartial ? (
        <span
          className="text-[10px] font-normal text-muted-foreground"
          aria-label={`${formatNumber(aggregate.counted)} of ${formatNumber(aggregate.units)} requests metered`}
        >
          {formatCoverageTag(aggregate.counted, aggregate.units)}
        </span>
      ) : null}
    </span>
  );
}

function SummaryCards({
  groups,
  label,
  mode,
}: {
  groups: ReadonlyArray<UsageGroupFields>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <div className="grid gap-2 md:hidden" aria-label={label}>
      {groups.map((group) => {
        const metered = groupMeteredCaption(group);
        return (
          <div
            key={group.key}
            className="min-w-0 rounded-xl border border-starlight-gold/20 bg-starlight-void/75 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium">{sourceLabel(group.source)}</p>
              {metered ? (
                <span className="text-[11px] text-muted-foreground" title={metered.title}>
                  {metered.text}
                </span>
              ) : null}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Requests</dt>
                <dd
                  className="truncate font-semibold tabular-nums"
                  title={formatNumber(group.requests)}
                >
                  {formatMetric(group.requests, mode)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Input</dt>
                <dd className="truncate font-medium">
                  <TokenCell aggregate={group.input} mode={mode} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">Output</dt>
                <dd className="truncate font-medium">
                  <TokenCell aggregate={group.output} mode={mode} />
                </dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function SummaryTable({
  groups,
  label,
  mode,
}: {
  groups: ReadonlyArray<UsageGroupFields>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-xl border border-starlight-gold/20 bg-starlight-void/70 md:block">
      <table className="w-full text-sm" aria-label={label}>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Requests</th>
            <th className="px-3 py-2 text-right font-medium">Input</th>
            <th className="px-3 py-2 text-right font-medium">Cached</th>
            <th className="px-3 py-2 text-right font-medium">Output</th>
            <th className="px-3 py-2 text-right font-medium">Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const metered = groupMeteredCaption(group);
            return (
              <tr key={group.key} className="border-t">
                <td className="px-3 py-2" title={`${group.accountingBasis} · ${group.unitKind}`}>
                  <span className="font-medium">{sourceLabel(group.source)}</span>
                  {metered ? (
                    <span className="ml-2 text-[11px] text-muted-foreground" title={metered.title}>
                      {metered.text}
                    </span>
                  ) : null}
                </td>
                <td
                  className="px-3 py-2 text-right font-medium tabular-nums"
                  title={formatNumber(group.requests)}
                >
                  {formatMetric(group.requests, mode)}
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.input} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.cached} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.output} mode={mode} />
                </td>
                <td className="px-3 py-2 text-right">
                  <TokenCell aggregate={group.reasoning} mode={mode} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Summary({
  groups,
  label,
  mode,
}: {
  groups: ReadonlyArray<UsageGroupFields>;
  label: string;
  mode: NumberMode;
}) {
  return (
    <>
      <SummaryCards groups={groups} label={`${label} (mobile)`} mode={mode} />
      <SummaryTable groups={groups} label={label} mode={mode} />
    </>
  );
}

export function DailyDetailTable({ group, mode }: { group: DailyUsageGroup; mode: NumberMode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full text-sm"
        aria-label={`Daily exact values for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
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
            <tr key={`${group.key}-${row.date}`} className="border-t">
              <td className="px-3 py-1.5 font-mono text-xs">{row.date}</td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                title={formatNumber(row.unit_count)}
              >
                {formatMetric(row.unit_count, mode)}
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-1.5 text-right">
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
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table
        className="w-full text-sm"
        aria-label={`Monthly detail for ${sourceLabel(group.source)} · ${group.accountingBasis} · ${group.unitKind}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{actorLabel(group.rows[0]?.actor_kind ?? "")}</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Effort</th>
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
              key={`${group.key}-${row.actor_kind}-${row.actor_id}-${row.model}-${row.effort}`}
              className="border-t"
            >
              <td className="px-3 py-1.5 font-medium">{row.actor_id}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{row.model}</td>
              <td className="px-3 py-1.5 text-xs">
                {row.effort === "" ? <span className="text-muted-foreground">—</span> : row.effort}
              </td>
              <td
                className="px-3 py-1.5 text-right tabular-nums"
                title={formatNumber(row.unit_count)}
              >
                {formatMetric(row.unit_count, mode)}
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <td key={column.value} className="px-3 py-1.5 text-right">
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
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Breakdown</h3>
      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No breakdown rows for this month.
        </div>
      ) : (
        groups.map((group) => {
          const metered = groupMeteredCaption(group);
          return (
            <details
              key={group.key}
              className="min-w-0 rounded-xl border border-starlight-gold/20 bg-starlight-void/75 px-3 py-2"
            >
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{sourceLabel(group.source)}</span>
                  <span className="text-xs text-muted-foreground">{group.rows.length} rows</span>
                </div>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className="font-medium text-foreground tabular-nums"
                    title={formatNumber(group.requests)}
                  >
                    {formatMetric(group.requests, mode)} req
                  </span>
                  {metered ? <span title={metered.title}>{metered.text}</span> : null}
                </span>
              </summary>
              <div className="mt-2">
                <MonthlyDetailTable group={group} mode={mode} />
              </div>
            </details>
          );
        })
      )}
    </section>
  );
}
