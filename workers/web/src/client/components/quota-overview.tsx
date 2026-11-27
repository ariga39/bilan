import type {
  QuotaAttempt,
  QuotaObservation,
  QuotaResponse,
  QuotaSubject,
  QuotaWindow,
} from "@bilan/shared";
import { filterVisibleQuotaSubjects } from "@bilan/shared";
import { AlertTriangle, CheckCircle2, Clock3, Gauge, KeyRound, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber, formatSpan } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SourceMeta {
  label: string;
  accountLabel: string;
  description: string;
}

const SOURCE_META = {
  opencode: {
    label: "OpenCode Go",
    accountLabel: "Key",
    description: "Active keys in the last seven days.",
  },
  codex: {
    label: "Codex",
    accountLabel: "Account",
    description: "Per Codex quota account.",
  },
  agy: {
    label: "AGY",
    accountLabel: "Account",
    description: "Model groups and windows stay distinct.",
  },
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
      return {
        label: source,
        accountLabel: "Account",
        description: "Per source account.",
      };
  }
}

function primaryPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function exactPercent(value: number | null): string {
  return value === null ? "Not reported" : `${formatNumber(value)}%`;
}

interface ResetDetails {
  label: string;
  at: string | null;
}

function resetDetails(window: QuotaWindow): ResetDetails {
  if (window.resets_at === null) {
    return { label: "Reset not reported", at: null };
  }
  if (Date.parse(window.resets_at) === EPOCH_RESET_MS) {
    // Some upstream payloads use the Unix epoch as a missing-reset sentinel.
    return { label: "Reset not reported", at: null };
  }
  if (window.reset_in_seconds === null) {
    return { label: "Reset time not reported", at: window.resets_at };
  }
  if (window.reset_in_seconds <= 0) {
    return { label: "Reset time passed", at: window.resets_at };
  }
  return { label: `Resets in ${formatSpan(window.reset_in_seconds)}`, at: window.resets_at };
}

function WindowStatus({ window }: { window: QuotaWindow }) {
  if (window.status === null) {
    return <Badge variant="outline">Not reported</Badge>;
  }
  if (window.status === "ok") {
    return (
      <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
        <CheckCircle2 />
        OK
      </Badge>
    );
  }
  if (window.status === "limited") {
    return (
      <Badge variant="outline" className="border-destructive/30 bg-destructive/5 text-destructive">
        <AlertTriangle />
        Limited
      </Badge>
    );
  }
  if (window.status === "cooldown") {
    return (
      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
        <Clock3 />
        Cooldown
      </Badge>
    );
  }
  return <Badge variant="outline">Unknown</Badge>;
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
      {attempt.status === "error" ? "Latest attempt failed" : "Latest attempt was empty"} ·{" "}
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

function SampleLine({ observation }: { observation: QuotaObservation }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Clock3 className="size-3.5" />
      <span>
        {formatDateTime(observation.sampled_at)} · {formatAge(observation.sample_age_seconds)}
      </span>
      {observation.is_stale ? (
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
          Stale
        </Badge>
      ) : null}
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

function isWarningStatus(status: QuotaWindow["status"]): boolean {
  return status === "limited" || status === "cooldown";
}

function limitingWindow(subject: QuotaSubject): QuotaWindow | null {
  const windows = subject.latest_valid?.windows ?? [];
  if (windows.length === 0) {
    return null;
  }
  const warnings = windows.filter((window) => isWarningStatus(window.status));
  const candidates = warnings.length > 0 ? warnings : windows;
  const known = candidates.filter(
    (window): window is QuotaWindow & { remaining_percent: number } =>
      window.remaining_percent !== null,
  );
  if (known.length === 0) {
    return candidates[0] ?? null;
  }
  return known.reduce((lowest, window) =>
    window.remaining_percent < lowest.remaining_percent ? window : lowest,
  );
}

function WindowReading({
  window,
  showBucket = null,
  exact = false,
}: {
  window: QuotaWindow;
  showBucket?: string | null;
  exact?: boolean;
}) {
  const reset = resetDetails(window);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {showBucket ? <span className="font-mono text-[11px]">{showBucket} · </span> : null}
          {window.slot}
          {window.label ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">{window.label}</span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {reset.label}
          {reset.at ? ` · ${formatDateTime(reset.at)}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-right">
          <span className="block text-base font-semibold tabular-nums">
            {exact
              ? exactPercent(window.remaining_percent)
              : primaryPercent(window.remaining_percent)}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            remaining · used {exactPercent(window.used_percent)}
          </span>
        </span>
        <WindowStatus window={window} />
      </div>
    </div>
  );
}

function AllWindows({ subject }: { subject: QuotaSubject }) {
  if (!subject.latest_valid) {
    return null;
  }
  return (
    <details className="rounded-md border bg-card px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        All readings · {subject.latest_valid.windows.length}
      </summary>
      <div className="mt-2 space-y-2">
        <SampleLine observation={subject.latest_valid} />
        {windowGroups(subject).map((group) => (
          <div key={group.bucketId} className="space-y-1.5">
            {group.bucketId !== subject.account ? (
              <p className="font-mono text-[11px] text-muted-foreground">{group.bucketId}</p>
            ) : null}
            {group.windows.map((window) => (
              <WindowReading
                key={`${window.bucket_id}-${window.slot}`}
                window={window}
                showBucket={group.bucketId !== subject.account ? group.bucketId : null}
                exact
              />
            ))}
          </div>
        ))}
        <p className="text-muted-foreground">
          Observed by {subject.latest_valid.observer_machine} · interval{" "}
          {subject.latest_valid.interval_seconds === null
            ? "not reported"
            : formatSpan(subject.latest_valid.interval_seconds)}
        </p>
      </div>
    </details>
  );
}

function PlatformCard({ source, subjects }: { source: string; subjects: Array<QuotaSubject> }) {
  const meta = sourceMeta(source);
  return (
    <Card className="h-fit gap-3 py-4">
      <CardHeader className="gap-0.5 px-4 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4 text-muted-foreground" />
          {meta.label}
        </CardTitle>
        <CardDescription className="text-xs">{meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {subjects.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No {meta.label} quota observations yet.
          </p>
        ) : (
          subjects.map((subject) => {
            const valid = subject.latest_valid;
            const limiting = limitingWindow(subject);
            return (
              <section key={`${subject.source}-${subject.account}`} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {meta.accountLabel}
                    </p>
                    <p className="font-mono text-xs font-medium">{subject.account}</p>
                  </div>
                  {valid ? (
                    <p className="text-[11px] text-muted-foreground">
                      {formatAge(valid.sample_age_seconds)}
                    </p>
                  ) : null}
                </div>
                <AttemptWarning attempt={subject.latest_attempt} />
                <AnomalyWarning subject={subject} />
                {limiting ? (
                  <WindowReading
                    window={limiting}
                    showBucket={limiting.bucket_id !== subject.account ? limiting.bucket_id : null}
                  />
                ) : (
                  <p className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
                    No valid quota windows yet.
                  </p>
                )}
                <AllWindows subject={subject} />
              </section>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function openCodeTightestKey(subjects: Array<QuotaSubject>): string | null {
  let tightest: { key: string; remaining: number } | null = null;
  for (const subject of subjects) {
    for (const window of subject.latest_valid?.windows ?? []) {
      if (window.remaining_percent === null) {
        continue;
      }
      const key = `${subject.account}\u0000${window.bucket_id}\u0000${window.slot}`;
      if (tightest === null || window.remaining_percent < tightest.remaining) {
        tightest = { key, remaining: window.remaining_percent };
      }
    }
  }
  return tightest?.key ?? null;
}

function OpenCodeRow({
  subject,
  tightestKey,
}: {
  subject: QuotaSubject;
  tightestKey: string | null;
}) {
  const limiting = limitingWindow(subject);
  const key = limiting
    ? `${subject.account}\u0000${limiting.bucket_id}\u0000${limiting.slot}`
    : null;
  const isTightest = key !== null && key === tightestKey;
  const reset = limiting ? resetDetails(limiting) : null;
  const valid = subject.latest_valid;
  const attempt = subject.latest_attempt;
  const hasAnomaly = subject.anomalies.length > 0 || Boolean(valid?.time_anomaly);
  return (
    <details className={cn("rounded-lg border", isTightest && "border-amber-400 bg-amber-50/40")}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-medium">{subject.account}</span>
          <span className="block text-[11px] text-muted-foreground">
            {limiting
              ? `${limiting.slot}${limiting.label ? ` · ${limiting.label}` : ""}`
              : "No valid window"}
            {reset ? ` · ${reset.label}` : ""}
            {reset?.at ? ` · ${formatDateTime(reset.at)}` : ""}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {valid
              ? `Valid sample ${formatAge(valid.sample_age_seconds)}${valid.is_stale ? " · stale" : ""}`
              : "No valid sample"}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {isTightest ? (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
              Tightest
            </Badge>
          ) : null}
          <span className="text-base font-semibold tabular-nums">
            {primaryPercent(limiting?.remaining_percent ?? null)}
          </span>
          {limiting ? <WindowStatus window={limiting} /> : null}
        </span>
        {valid?.is_stale ||
        attempt?.status === "error" ||
        attempt?.status === "empty" ||
        hasAnomaly ? (
          <span className="flex w-full flex-wrap gap-x-2 gap-y-1 text-[11px]">
            {valid?.is_stale ? <span className="text-amber-800">Stale sample</span> : null}
            {attempt?.status === "error" ? (
              <span className="text-destructive">Latest attempt failed</span>
            ) : null}
            {attempt?.status === "empty" ? (
              <span className="text-amber-800">Latest attempt empty</span>
            ) : null}
            {hasAnomaly ? <span className="text-amber-800">Clock anomaly</span> : null}
          </span>
        ) : null}
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        <AttemptWarning attempt={subject.latest_attempt} />
        <AnomalyWarning subject={subject} />
        <AllWindows subject={subject} />
      </div>
    </details>
  );
}

function OpenCodeOverview({ subjects }: { subjects: Array<QuotaSubject> }) {
  const tightestKey = openCodeTightestKey(subjects);
  return (
    <Card className="h-fit gap-3 py-4">
      <CardHeader className="gap-0.5 px-4 pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 text-muted-foreground" />
            OpenCode Go
          </CardTitle>
          <CardDescription className="text-xs">
            {subjects.length} active {subjects.length === 1 ? "key" : "keys"} · last 7 days
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {subjects.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            No OpenCode Go key has reported in the last seven days.
          </p>
        ) : (
          subjects.map((subject) => (
            <OpenCodeRow
              key={`${subject.source}-${subject.account}`}
              subject={subject}
              tightestKey={tightestKey}
            />
          ))
        )}
        <p className="text-[11px] text-muted-foreground">
          Each row shows its limiting window; expand for every reading and status. Percentages are
          never pooled across keys or windows.
        </p>
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
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <PlatformCard source="codex" subjects={codex} />
        <PlatformCard source="agy" subjects={agy} />
      </div>
      <OpenCodeOverview subjects={opencode} />
    </div>
  );
}
