import type { QuotaAttempt, QuotaResponse, QuotaSubject, QuotaWindow } from "@bilan/shared";
import { filterVisibleQuotaSubjects } from "@bilan/shared";
import { AlertTriangle, Clock3, Gauge, KeyRound, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber, formatSpan } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SourceMeta {
  label: string;
}

const SOURCE_META = {
  opencode: { label: "OpenCode Go" },
  codex: { label: "Codex" },
  agy: { label: "AGY" },
} satisfies Record<string, SourceMeta>;

const EPOCH_RESET_MS = 0;

function sourceMeta(source: string): SourceMeta {
  switch (source) {
    case "opencode":
      return SOURCE_META.opencode;
    case "codex":
      return SOURCE_META.codex;
    case "agy":
      return SOURCE_META.agy;
    default:
      return { label: source };
  }
}

function effectiveRemaining(window: QuotaWindow): number | null {
  if (window.remaining_percent !== null) {
    return Math.max(0, Math.min(100, window.remaining_percent));
  }
  if (window.used_percent !== null) {
    return Math.max(0, Math.min(100, 100 - window.used_percent));
  }
  return null;
}

function primaryPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function exactPercent(value: number | null): string {
  return value === null ? "Not reported" : `${formatNumber(Number(value.toFixed(2)))}%`;
}

function barColor(remaining: number | null, status: QuotaWindow["status"]): string {
  if (status === "limited" || (remaining !== null && remaining <= 10)) {
    return "bg-rose-500";
  }
  if (status === "cooldown" || (remaining !== null && remaining <= 35)) {
    return "bg-amber-500";
  }
  return "bg-emerald-500";
}

function percentTextColor(remaining: number | null, status: QuotaWindow["status"]): string {
  if (status === "limited" || (remaining !== null && remaining <= 10)) {
    return "text-rose-600";
  }
  if (status === "cooldown" || (remaining !== null && remaining <= 35)) {
    return "text-amber-700";
  }
  return "text-foreground";
}

interface ResetDetails {
  short: string | null;
  at: string | null;
}

function resetDetails(window: QuotaWindow): ResetDetails {
  if (window.resets_at === null || Date.parse(window.resets_at) === EPOCH_RESET_MS) {
    return { short: null, at: null };
  }
  if (window.reset_in_seconds === null) {
    return { short: null, at: window.resets_at };
  }
  if (window.reset_in_seconds <= 0) {
    return { short: "Reset passed", at: window.resets_at };
  }
  return { short: `in ${formatSpan(window.reset_in_seconds)}`, at: window.resets_at };
}

function WindowWarningBadge({ status }: { status: QuotaWindow["status"] }) {
  if (status === "limited") {
    return (
      <Badge
        variant="outline"
        className="border-rose-300 bg-rose-50 px-1.5 py-0 text-[10px] text-rose-700"
      >
        <AlertTriangle className="size-3" />
        Limited
      </Badge>
    );
  }
  if (status === "cooldown") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800"
      >
        <Clock3 className="size-3" />
        Cooldown
      </Badge>
    );
  }
  return null;
}

function AttemptWarning({ attempt }: { attempt: QuotaAttempt | null }) {
  if (attempt === null || attempt.status === "ok") {
    return null;
  }
  return (
    <p
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-xs",
        attempt.status === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-amber-300 bg-amber-50 text-amber-900",
      )}
    >
      {attempt.status === "error" ? "Latest attempt failed" : "Latest attempt empty"} ·{" "}
      {formatDateTime(attempt.sampled_at)}
      {attempt.error_summary ? ` · ${attempt.error_summary}` : null}
    </p>
  );
}

function AnomalyWarning({ subject }: { subject: QuotaSubject }) {
  const anomalies = [
    ...subject.anomalies,
    ...(subject.latest_valid?.time_anomaly ? [subject.latest_valid] : []),
  ];
  if (anomalies.length === 0) {
    return null;
  }
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
      <TriangleAlert className="mr-1 inline size-3.5" />
      Clock anomaly:{" "}
      {anomalies
        .map(
          (anomaly) =>
            `${anomaly.time_anomaly ?? "unspecified"} at ${formatDateTime(anomaly.sampled_at)}`,
        )
        .join("; ")}
    </p>
  );
}

function windowGroups(
  subject: QuotaSubject,
): Array<{ bucketId: string; windows: Array<QuotaWindow> }> {
  const groups = new Map<string, Array<QuotaWindow>>();
  for (const window of subject.latest_valid?.windows ?? []) {
    const group = groups.get(window.bucket_id) ?? [];
    group.push(window);
    groups.set(window.bucket_id, group);
  }
  return [...groups.entries()].map(([bucketId, windows]) => ({ bucketId, windows }));
}

function windowTitle(window: QuotaWindow): string {
  const parts = [
    `${exactPercent(window.remaining_percent)} remaining`,
    `${exactPercent(window.used_percent)} used`,
  ];
  const reset = resetDetails(window);
  if (reset.at) {
    parts.push(`Resets ${formatDateTime(reset.at)}`);
  }
  return parts.join(" · ");
}

function windowLabel(window: QuotaWindow): string {
  if (window.label && window.label !== window.slot) {
    return window.label;
  }
  return window.slot;
}

function QuotaGaugeRow({ window }: { window: QuotaWindow }) {
  const remaining = effectiveRemaining(window);
  const reset = resetDetails(window);
  return (
    <div className="min-w-0 space-y-1" title={windowTitle(window)}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{windowLabel(window)}</span>
          <WindowWarningBadge status={window.status} />
        </div>
        <div className="flex shrink-0 items-baseline gap-2">
          {reset.short ? (
            <span
              className="text-[11px] text-muted-foreground"
              title={reset.at ? formatDateTime(reset.at) : undefined}
            >
              {reset.short}
            </span>
          ) : null}
          <span
            className={cn(
              "w-9 text-right text-sm font-semibold tabular-nums",
              percentTextColor(remaining, window.status),
            )}
          >
            {primaryPercent(remaining)}
          </span>
        </div>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${windowLabel(window)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
      >
        {remaining !== null ? (
          <div
            className={cn("h-full rounded-full transition-all", barColor(remaining, window.status))}
            style={{ width: `${remaining}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function PlatformCard({ source, subjects }: { source: string; subjects: Array<QuotaSubject> }) {
  const meta = sourceMeta(source);
  return (
    <Card className="h-full min-w-0 gap-3 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="size-4 text-muted-foreground" />
            {meta.label}
          </CardTitle>
          {subjects.length === 1 && subjects[0]?.latest_valid ? (
            <span
              className="text-[11px] text-muted-foreground"
              title={formatDateTime(subjects[0].latest_valid.sampled_at)}
            >
              {subjects[0].account} · {formatAge(subjects[0].latest_valid.sample_age_seconds)}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {subjects.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No {meta.label} quota data yet.
          </p>
        ) : (
          subjects.map((subject) => {
            const valid = subject.latest_valid;
            const groups = windowGroups(subject);
            const showGroupHeaders =
              groups.length > 1 ||
              (groups.length === 1 &&
                groups[0]?.bucketId !== subject.account &&
                groups[0]?.bucketId !== subject.source);
            return (
              <section key={`${subject.source}-${subject.account}`} className="min-w-0 space-y-2.5">
                {subjects.length > 1 ? (
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs font-medium">{subject.account}</span>
                    {valid ? (
                      <span className="text-[11px] text-muted-foreground">
                        {formatAge(valid.sample_age_seconds)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <AttemptWarning attempt={subject.latest_attempt} />
                <AnomalyWarning subject={subject} />
                {groups.length > 0 ? (
                  <div className="space-y-3">
                    {groups.map((group) => (
                      <div key={group.bucketId} className="space-y-2">
                        {showGroupHeaders ? (
                          <p className="text-[11px] font-medium text-muted-foreground">
                            {group.bucketId}
                          </p>
                        ) : null}
                        <div
                          className={cn(
                            "grid gap-2.5",
                            group.windows.length === 2 && "sm:grid-cols-2",
                          )}
                        >
                          {group.windows.map((window) => (
                            <QuotaGaugeRow
                              key={`${window.bucket_id}-${window.slot}`}
                              window={window}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
                    No valid quota windows yet.
                  </p>
                )}
              </section>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function subjectLowestRemaining(subject: QuotaSubject): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const window of subject.latest_valid?.windows ?? []) {
    if (window.status === "limited") {
      return -1;
    }
    const remaining = effectiveRemaining(window);
    if (remaining !== null && remaining < lowest) {
      lowest = remaining;
    }
  }
  return lowest;
}

function OpenCodeKeyCard({ subject, isTightest }: { subject: QuotaSubject; isTightest: boolean }) {
  const valid = subject.latest_valid;
  const windows = valid?.windows ?? [];
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border px-3 py-2.5 space-y-2",
        isTightest && "border-amber-300 bg-amber-50/30",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium">{subject.account}</span>
          {isTightest ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800"
            >
              Tightest
            </Badge>
          ) : null}
          {valid?.is_stale ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800"
            >
              Stale
            </Badge>
          ) : null}
        </div>
        {valid ? (
          <span
            className="text-[11px] text-muted-foreground"
            title={formatDateTime(valid.sampled_at)}
          >
            {formatAge(valid.sample_age_seconds)}
          </span>
        ) : null}
      </div>
      <AttemptWarning attempt={subject.latest_attempt} />
      <AnomalyWarning subject={subject} />
      {windows.length > 0 ? (
        <div className="grid gap-2.5 sm:grid-cols-3">
          {windows.map((window) => (
            <QuotaGaugeRow key={`${window.bucket_id}-${window.slot}`} window={window} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No valid quota windows.</p>
      )}
    </div>
  );
}

function OpenCodeOverview({ subjects }: { subjects: Array<QuotaSubject> }) {
  let tightestAccount: string | null = null;
  let tightestValue = Number.POSITIVE_INFINITY;
  for (const subject of subjects) {
    const score = subjectLowestRemaining(subject);
    if (score < tightestValue) {
      tightestValue = score;
      tightestAccount = subject.account;
    }
  }
  const hasMultiple = subjects.length > 1;
  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 text-muted-foreground" />
            OpenCode Go
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {subjects.length} active {subjects.length === 1 ? "key" : "keys"} · 7d
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 px-4">
        {subjects.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No active OpenCode Go keys in the last 7 days.
          </p>
        ) : (
          subjects.map((subject) => (
            <OpenCodeKeyCard
              key={`${subject.source}-${subject.account}`}
              subject={subject}
              isTightest={hasMultiple && subject.account === tightestAccount && tightestValue <= 35}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function QuotaOverview({ quota }: { quota: QuotaResponse }) {
  const subjects = filterVisibleQuotaSubjects(quota.subjects, new Date(quota.generated_at));
  const codex = subjects.filter((subject) => subject.source === "codex");
  const agy = subjects.filter((subject) => subject.source === "agy");
  const opencode = subjects.filter((subject) => subject.source === "opencode");

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <PlatformCard source="codex" subjects={codex} />
        <PlatformCard source="agy" subjects={agy} />
      </div>
      <OpenCodeOverview subjects={opencode} />
    </div>
  );
}
