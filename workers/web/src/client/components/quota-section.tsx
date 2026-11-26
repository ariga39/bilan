import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Gauge,
  KeyRound,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber, formatSpan } from "@/lib/format";
import type {
  QuotaAnomaly,
  QuotaAttempt,
  QuotaObservation,
  QuotaResponse,
  QuotaSubject,
  QuotaWindow,
  QuotaWindowStatus,
} from "@/lib/quota";
import { cn } from "@/lib/utils";

interface SourceMeta {
  label: string;
  accountLabel: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
}

const SOURCE_ORDER = ["opencode", "codex", "agy"];

const SOURCE_META = {
  opencode: {
    label: "OpenCode Go",
    accountLabel: "Key",
    description: "Per upstream key fingerprint",
    icon: KeyRound,
    iconClassName: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  codex: {
    label: "Codex",
    accountLabel: "Account",
    description: "Per Codex quota account",
    icon: Bot,
    iconClassName: "border-sky-200 bg-sky-50 text-sky-700",
  },
  agy: {
    label: "AGY",
    accountLabel: "Account",
    description: "Per AGY quota account",
    icon: Gauge,
    iconClassName: "border-violet-200 bg-violet-50 text-violet-700",
  },
} satisfies Record<string, SourceMeta>;

function isKnownSource(source: string): source is keyof typeof SOURCE_META {
  return source === "opencode" || source === "codex" || source === "agy";
}

function sourceMeta(source: string): SourceMeta {
  return (
    (isKnownSource(source) ? SOURCE_META[source] : undefined) ?? {
      label: source,
      accountLabel: "Account",
      description: "Per source account",
      icon: Gauge,
      iconClassName: "border-slate-200 bg-slate-50 text-slate-700",
    }
  );
}

function sourceRank(source: string): number {
  const index = SOURCE_ORDER.indexOf(source);
  return index === -1 ? SOURCE_ORDER.length : index;
}

function percentLabel(value: number | null): string {
  return value === null ? "Not reported" : `${formatNumber(value)}%`;
}

function resetLabel(window: QuotaWindow): string {
  if (window.resets_at === null || window.reset_in_seconds === null) {
    return "Not reported";
  }
  if (window.reset_in_seconds <= 0) {
    return "Reset time passed";
  }
  return `in ${formatSpan(window.reset_in_seconds)}`;
}

function WindowStatusBadge({ status }: { status: QuotaWindowStatus | null }) {
  if (status === null) {
    return <Badge variant="outline">Not reported</Badge>;
  }
  switch (status) {
    case "ok":
      return (
        <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
          <CheckCircle2 />
          OK
        </Badge>
      );
    case "limited":
      return (
        <Badge
          variant="outline"
          className="border-destructive/30 bg-destructive/5 text-destructive"
        >
          <AlertTriangle />
          Limited
        </Badge>
      );
    case "cooldown":
      return (
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
          <Clock3 />
          Cooldown
        </Badge>
      );
    case "unknown":
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function QuotaWindowTable({
  subject,
  windows,
}: {
  subject: QuotaSubject;
  windows: Array<QuotaWindow>;
}) {
  const meta = sourceMeta(subject.source);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table
        className="w-full min-w-[44rem] text-sm"
        aria-label={`Quota windows for ${meta.label} ${subject.account}`}
      >
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Window</th>
            <th className="px-3 py-2 text-right font-medium">Used</th>
            <th className="px-3 py-2 text-right font-medium">Remaining</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Resets</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((window) => (
            <tr key={`${window.bucket_id}-${window.slot}`} className="border-t align-top">
              <td className="px-3 py-2">
                <span className="font-medium">{window.slot}</span>
                {window.label ? (
                  <span className="ml-2 text-xs text-muted-foreground">{window.label}</span>
                ) : null}
                {window.bucket_id !== subject.account ? (
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {window.bucket_id}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {percentLabel(window.used_percent)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {percentLabel(window.remaining_percent)}
              </td>
              <td className="px-3 py-2">
                <WindowStatusBadge status={window.status} />
              </td>
              <td className="px-3 py-2">
                <span className="block">{resetLabel(window)}</span>
                {window.resets_at ? (
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(window.resets_at)}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleSummary({ observation }: { observation: QuotaObservation }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Clock3 className="size-3.5" />
        Sampled {formatDateTime(observation.sampled_at)} ·{" "}
        {formatAge(observation.sample_age_seconds)}
      </span>
      <span>
        Observed by{" "}
        <span className="font-mono text-foreground">{observation.observer_machine}</span>
      </span>
    </div>
  );
}

function AttemptWarning({ attempt }: { attempt: QuotaAttempt | null }) {
  if (attempt === null || attempt.status === "ok") {
    return null;
  }

  if (attempt.status === "error") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          Latest attempt failed
        </div>
        <p className="mt-1 text-muted-foreground">
          {formatDateTime(attempt.sampled_at)} · {formatAge(attempt.sample_age_seconds)}
        </p>
        {attempt.error_summary ? (
          <p className="mt-1 text-destructive">{attempt.error_summary}</p>
        ) : (
          <p className="mt-1 text-muted-foreground">No error detail was reported.</p>
        )}
        <p className="mt-1 text-muted-foreground">
          Any valid windows below are from the last successful sample.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex items-center gap-1.5 font-medium">
        <Clock3 className="size-3.5" aria-hidden="true" />
        Latest attempt was empty
      </div>
      <p className="mt-1 text-amber-800/80">
        {formatDateTime(attempt.sampled_at)} · {formatAge(attempt.sample_age_seconds)}
      </p>
      <p className="mt-1">No numeric reading is derived from an empty sample.</p>
    </div>
  );
}

function AnomalyWarnings({ anomalies }: { anomalies: Array<QuotaAnomaly> }) {
  if (anomalies.length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      aria-label="Quota clock anomalies"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        Clock anomaly detected
      </div>
      <ul className="mt-1 space-y-1">
        {anomalies.map((anomaly) => (
          <li key={anomaly.sample_id}>
            <span className="font-mono">{anomaly.time_anomaly ?? "unspecified"}</span>
            <span className="text-amber-800/80">
              {" "}
              · {formatDateTime(anomaly.sampled_at)} · {formatAge(anomaly.sample_age_seconds)}
            </span>
            {anomaly.error_summary ? (
              <span className="block text-amber-800/80">{anomaly.error_summary}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-amber-800/80">
        Anomalous samples never replace the latest valid quota windows.
      </p>
    </div>
  );
}

function QuotaSubjectCard({ subject }: { subject: QuotaSubject }) {
  const meta = sourceMeta(subject.source);
  const Icon = meta.icon;
  const valid = subject.latest_valid;

  return (
    <Card className={cn("gap-3 py-4", valid?.is_stale && "border-amber-300/80")}>
      <CardHeader className="gap-2 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg border",
                meta.iconClassName,
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-sm">{meta.label}</CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                {meta.accountLabel}{" "}
                <span className="font-mono text-foreground">{subject.account}</span>
              </CardDescription>
            </div>
          </div>
          {valid?.is_stale ? (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
              Stale sample
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <AttemptWarning attempt={subject.latest_attempt} />
        <AnomalyWarnings anomalies={subject.anomalies} />
        {valid ? (
          <div className="space-y-2">
            <SampleSummary observation={valid} />
            {valid.windows.length > 0 ? (
              <QuotaWindowTable subject={subject} windows={valid.windows} />
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                No windows in the latest valid sample. Older windows are not carried forward.
              </p>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            No valid quota sample yet. Errors, empty samples, and anomalies are shown separately and
            are never converted to 0%.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function QuotaSection({ quota }: { quota: QuotaResponse }) {
  const groupMap = new Map<string, Array<QuotaSubject>>();
  for (const subject of quota.subjects) {
    const group = groupMap.get(subject.source);
    if (group) {
      group.push(subject);
    } else {
      groupMap.set(subject.source, [subject]);
    }
  }
  const groups = [...groupMap.entries()]
    .map(([source, subjects]) => ({
      source,
      subjects: [...subjects].sort((left, right) => left.account.localeCompare(right.account)),
    }))
    .sort(
      (left, right) =>
        sourceRank(left.source) - sourceRank(right.source) ||
        left.source.localeCompare(right.source),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4 text-muted-foreground" />
          Quota windows
        </CardTitle>
        <CardDescription className="mt-1">
          Latest valid sample per source and account. OpenCode Go keys are identified by fingerprint
          and shown separately from Codex accounts. Missing windows disappear instead of carrying
          forward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {quota.subjects.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="font-medium">No quota observations yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Quota cards appear after a collector pushes a quota observation.
            </p>
          </div>
        ) : (
          groups.map((group) => {
            const meta = sourceMeta(group.source);
            const Icon = meta.icon;
            return (
              <section key={group.source} aria-label={`${meta.label} quota`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">{meta.label}</h3>
                  <span className="text-xs text-muted-foreground">{meta.description}</span>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {group.subjects.map((subject) => (
                    <QuotaSubjectCard
                      key={`${subject.source}-${subject.account}`}
                      subject={subject}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
        <p className="text-[11px] text-muted-foreground">
          Sample age is measured from the latest valid observation. Reset countdowns are relative to{" "}
          {formatDateTime(quota.generated_at)}.
        </p>
      </CardContent>
    </Card>
  );
}
