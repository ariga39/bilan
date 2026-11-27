import type {
  DailyUsageRow,
  UsageBreakdownRow,
  UsageCounters,
  UsageTokenColumn,
} from "@bilan/shared";

import { formatCompactNumber, formatNumber } from "./format";

export type NumberMode = "compact" | "exact";

export type CountedColumn =
  | "input_counted"
  | "cached_counted"
  | "uncached_counted"
  | "cache_write_counted"
  | "output_counted"
  | "reasoning_counted";

export const TOKEN_COLUMNS: ReadonlyArray<{
  value: UsageTokenColumn;
  counted: CountedColumn;
  label: string;
}> = [
  { value: "input_tokens", counted: "input_counted", label: "Input" },
  { value: "cached_tokens", counted: "cached_counted", label: "Cached" },
  { value: "uncached_tokens", counted: "uncached_counted", label: "Uncached" },
  { value: "cache_write_tokens", counted: "cache_write_counted", label: "Cache write" },
  { value: "output_tokens", counted: "output_counted", label: "Output" },
  { value: "reasoning_tokens", counted: "reasoning_counted", label: "Reasoning" },
];

export interface TokenAggregate {
  value: number | null;
  counted: number;
  units: number;
}

export interface UsageGroupFields {
  key: string;
  source: string;
  accountingBasis: string;
  unitKind: string;
  requests: number;
  gaps: number;
  input: TokenAggregate;
  cached: TokenAggregate;
  output: TokenAggregate;
  reasoning: TokenAggregate;
}

export interface UsageGroup<Row> extends UsageGroupFields {
  rows: Array<Row>;
}

export type MonthlyUsageGroup = UsageGroup<UsageBreakdownRow>;
export type DailyUsageGroup = UsageGroup<DailyUsageRow>;

export function formatMetric(value: number, mode: NumberMode): string {
  return mode === "compact" ? formatCompactNumber(value) : formatNumber(value);
}

export function formatCoverageTag(counted: number, total: number): string {
  if (total <= 0) {
    return "";
  }
  if (total < 1000) {
    return `${formatNumber(counted)}/${formatNumber(total)}`;
  }
  return `${Math.round((counted / total) * 1000) / 10}%`;
}

export function isAggregatePartial(aggregate: TokenAggregate): boolean {
  return aggregate.counted < aggregate.units;
}

export function aggregateTitle(aggregate: TokenAggregate): string {
  const titleParts = [formatNumber(aggregate.value ?? 0)];
  if (isAggregatePartial(aggregate)) {
    titleParts.push(`${formatNumber(aggregate.counted)}/${formatNumber(aggregate.units)} requests`);
  }
  return titleParts.join(" · ");
}

export function aggregateToken<T extends UsageCounters>(
  rows: ReadonlyArray<T>,
  column: UsageTokenColumn,
  counted: CountedColumn,
): TokenAggregate {
  let value: number | null = null;
  let countedTotal = 0;
  let units = 0;
  for (const row of rows) {
    units += row.unit_count;
    countedTotal += row[counted];
    const cell = row[column];
    if (cell !== null) {
      value = (value ?? 0) + cell;
    }
  }
  return { value, counted: countedTotal, units };
}

function groupKey(row: { source: string; accounting_basis: string; unit_kind: string }): string {
  return `${row.source}\u0000${row.accounting_basis}\u0000${row.unit_kind}`;
}

function emptyGroup<Row>(row: {
  source: string;
  accounting_basis: string;
  unit_kind: string;
}): UsageGroup<Row> {
  return {
    key: groupKey(row),
    source: row.source,
    accountingBasis: row.accounting_basis,
    unitKind: row.unit_kind,
    requests: 0,
    gaps: 0,
    input: { value: null, counted: 0, units: 0 },
    cached: { value: null, counted: 0, units: 0 },
    output: { value: null, counted: 0, units: 0 },
    reasoning: { value: null, counted: 0, units: 0 },
    rows: [],
  };
}

function populateMetrics<Row extends UsageCounters & { coverage_gaps: number }>(
  group: UsageGroup<Row>,
): void {
  group.requests = group.rows.reduce((total, row) => total + row.unit_count, 0);
  group.gaps = group.rows.reduce((total, row) => total + row.coverage_gaps, 0);
  group.input = aggregateToken(group.rows, "input_tokens", "input_counted");
  group.cached = aggregateToken(group.rows, "cached_tokens", "cached_counted");
  group.output = aggregateToken(group.rows, "output_tokens", "output_counted");
  group.reasoning = aggregateToken(group.rows, "reasoning_tokens", "reasoning_counted");
}

function sortGroups<Row>(groups: Array<UsageGroup<Row>>): Array<UsageGroup<Row>> {
  return [...groups].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.accountingBasis.localeCompare(right.accountingBasis) ||
      left.unitKind.localeCompare(right.unitKind),
  );
}

function groupUsageRows<
  Row extends UsageCounters & {
    source: string;
    accounting_basis: string;
    unit_kind: string;
    coverage_gaps: number;
  },
>(
  rows: ReadonlyArray<Row>,
  compareRows?: (left: Row, right: Row) => number,
): Array<UsageGroup<Row>> {
  const groups = new Map<string, UsageGroup<Row>>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? emptyGroup<Row>(row);
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (compareRows) {
      group.rows.sort(compareRows);
    }
    populateMetrics(group);
  }
  return sortGroups([...groups.values()]);
}

/**
 * Summarizes rows by source, accounting basis, and unit kind without imposing a
 * row order, so compact overview cards share the usage view's accounting.
 */
export function summarizeUsageRows<
  Row extends UsageCounters & {
    source: string;
    accounting_basis: string;
    unit_kind: string;
    coverage_gaps: number;
  },
>(rows: ReadonlyArray<Row>): Array<UsageGroup<Row>> {
  return groupUsageRows(rows).sort((left, right) => left.source.localeCompare(right.source));
}

export function groupMonthlyRows(rows: ReadonlyArray<UsageBreakdownRow>): Array<MonthlyUsageGroup> {
  return groupUsageRows(
    rows,
    (left, right) =>
      (right.input_tokens ?? -1) - (left.input_tokens ?? -1) ||
      right.unit_count - left.unit_count ||
      left.actor_id.localeCompare(right.actor_id) ||
      left.model.localeCompare(right.model),
  );
}

export function groupDailyRows(rows: ReadonlyArray<DailyUsageRow>): Array<DailyUsageGroup> {
  return groupUsageRows(rows, (left, right) => left.date.localeCompare(right.date));
}

export interface CoverageSummary {
  requests: number;
  gaps: number;
  minCounted: number;
  percent: number;
  isPartial: boolean;
}

/**
 * Computes the shared coverage boundary: only reported token columns constrain
 * metered units, and coverage gaps count towards incompleteness even when every
 * reported column is fully metered.
 */
export function coverageSummary(
  requests: number,
  gaps: number,
  aggregates: ReadonlyArray<TokenAggregate>,
): CoverageSummary | null {
  if (requests === 0) {
    return null;
  }
  const reportedCounteds = aggregates.flatMap((aggregate) =>
    aggregate.value !== null ? [aggregate.counted] : [],
  );
  const minCounted = reportedCounteds.length > 0 ? Math.min(...reportedCounteds) : requests;
  if (minCounted >= requests && gaps === 0) {
    return null;
  }
  return {
    requests,
    gaps,
    minCounted,
    percent: Math.round((minCounted / requests) * 1000) / 10,
    isPartial: minCounted < requests,
  };
}

export function meteredCaption(
  requests: number,
  gaps: number,
  aggregates: ReadonlyArray<TokenAggregate>,
  {
    includeGapsWhenPartial = true,
    mentionZeroGaps = true,
  }: {
    includeGapsWhenPartial?: boolean;
    mentionZeroGaps?: boolean;
  } = {},
): { text: string; title: string } | null {
  const coverage = coverageSummary(requests, gaps, aggregates);
  if (coverage === null) {
    return null;
  }
  const gapsText = `${formatNumber(coverage.gaps)} gap${coverage.gaps === 1 ? "" : "s"}`;
  const text =
    coverage.gaps > 0 && !coverage.isPartial
      ? gapsText
      : coverage.gaps > 0 && includeGapsWhenPartial
        ? `${coverage.percent}% metered · ${gapsText}`
        : `${coverage.percent}% metered`;
  return {
    text,
    title: `${formatNumber(coverage.minCounted)} of ${formatNumber(coverage.requests)} requests reported tokens${
      mentionZeroGaps || coverage.gaps > 0 ? ` (${formatNumber(coverage.gaps)} uncounted)` : ""
    }`,
  };
}
