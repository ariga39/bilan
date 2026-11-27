import type { QuotaAttempt, QuotaResponse, QuotaSubject, QuotaWindow } from "@bilan/shared";
import { Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/format";
import {
  isFiveHourWindow,
  isWeeklyWindow,
  sourceMeta,
  subjectLowestRemaining,
  windowGroups,
} from "@/lib/quota";
import { cn } from "@/lib/utils";

import { CharacterCutout, DiamondManaRow, SoulGemRing } from "./quota-gauges";

function AttemptWarning({ attempt }: { attempt: QuotaAttempt | null }) {
  if (attempt === null || attempt.status === "ok") {
    return null;
  }
  return (
    <p
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs",
        attempt.status === "error"
          ? "border-rose-400/40 bg-rose-500/15 text-rose-200"
          : "border-amber-400/40 bg-amber-500/15 text-amber-200",
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
    <p className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1.5 text-xs text-amber-200">
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

function SubjectMetaRow({ subject, showAccount }: { subject: QuotaSubject; showAccount: boolean }) {
  const valid = subject.latest_valid;
  if (!showAccount && !valid?.is_stale && valid === null) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
      <div className="flex min-w-0 items-center gap-1.5">
        {showAccount ? (
          <span className="truncate font-mono text-xs text-starlight-lilac">{subject.account}</span>
        ) : null}
        {valid?.is_stale ? (
          <Badge
            variant="outline"
            className="rounded-full border-amber-400/40 bg-amber-500/15 px-2 py-0 text-[10px] text-amber-200"
          >
            Stale
          </Badge>
        ) : null}
      </div>
      {valid ? (
        <span className="text-muted-foreground" title={formatDateTime(valid.sampled_at)}>
          ✦ {formatAge(valid.sample_age_seconds)}
        </span>
      ) : null}
    </div>
  );
}

function ChatGPTSubsCard({ subjects }: { subjects: Array<QuotaSubject> }) {
  const showAccount = subjects.length > 1;
  const singleFreshAge =
    subjects.length === 1 && !subjects[0]?.latest_valid?.is_stale
      ? (subjects[0]?.latest_valid?.sample_age_seconds ?? null)
      : null;

  return (
    <Card className="relative mt-5 min-w-0 gap-3 overflow-visible py-4">
      <CharacterCutout
        src="/mascot-chatgpt.png"
        glowFilter="drop-shadow(0 0 14px rgba(226, 232, 240, 0.5))"
        className="absolute -top-8 left-1.5 z-20 h-40 w-30 sm:h-44 sm:w-34"
      />
      <CardHeader className="pl-30 pr-4 pb-0 sm:pl-36">
        <div className="flex items-center justify-between gap-2">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-sm tracking-wide text-starlight-codex"
          >
            <Sparkles className="size-4 text-starlight-codex-soft" />
            {sourceMeta("codex").label}
          </CardTitle>
          {singleFreshAge !== null ? (
            <span className="text-[11px] text-muted-foreground">✦ {formatAge(singleFreshAge)}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pl-30 pr-4 sm:pl-36">
        {subjects.length === 0 ? (
          <p className="rounded-xl border border-dashed border-starlight-gold/25 px-3 py-4 text-center text-xs text-muted-foreground">
            No ChatGPT Subs quota observations yet.
          </p>
        ) : (
          subjects.map((subject) => {
            const windows = subject.latest_valid?.windows ?? [];
            return (
              <div key={`${subject.source}-${subject.account}`} className="space-y-2">
                {showAccount || subject.latest_valid?.is_stale ? (
                  <SubjectMetaRow subject={subject} showAccount={showAccount} />
                ) : null}
                <AttemptWarning attempt={subject.latest_attempt} />
                <AnomalyWarning subject={subject} />
                {windows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No valid quota windows.</p>
                ) : (
                  <div className="flex min-w-0 flex-col gap-2">
                    {windows.map((window) => (
                      <SoulGemRing
                        key={`codex-${subject.account}-${window.bucket_id}-${window.slot}`}
                        window={window}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function renderBucketWindows(
  subject: QuotaSubject,
  group: { bucketId: string; windows: Array<QuotaWindow> },
) {
  const weekly = group.windows.find(isWeeklyWindow);
  const fiveHour = group.windows.find(isFiveHourWindow);
  if (weekly && fiveHour) {
    const extraWindows = group.windows.filter((w) => w !== weekly && w !== fiveHour);
    return (
      <div key={`agy-${subject.account}-${group.bucketId}`} className="flex min-w-0 flex-col gap-2">
        <SoulGemRing
          window={weekly}
          accent="violet"
          titleOverride={group.bucketId}
          secondary={fiveHour}
        />
        {extraWindows.map((window) => (
          <SoulGemRing
            key={`agy-${subject.account}-${window.bucket_id}-${window.slot}`}
            window={window}
            accent="violet"
            titleOverride={group.bucketId}
          />
        ))}
      </div>
    );
  }
  return group.windows.map((window) => (
    <SoulGemRing
      key={`agy-${subject.account}-${window.bucket_id}-${window.slot}`}
      window={window}
      accent="violet"
      titleOverride={group.bucketId}
    />
  ));
}

function GoogleAISubsCard({ subjects }: { subjects: Array<QuotaSubject> }) {
  const showAccount = subjects.length > 1;
  const singleFreshAge =
    subjects.length === 1 && !subjects[0]?.latest_valid?.is_stale
      ? (subjects[0]?.latest_valid?.sample_age_seconds ?? null)
      : null;

  return (
    <Card className="relative mt-5 min-w-0 gap-3 overflow-visible py-4">
      <CharacterCutout
        src="/mascot-gemini.png"
        glowFilter="drop-shadow(0 0 14px rgba(192, 132, 252, 0.55))"
        className="absolute -top-8 left-1.5 z-20 h-40 w-30 sm:h-44 sm:w-34"
      />
      <CardHeader className="pl-30 pr-4 pb-0 sm:pl-36">
        <div className="flex items-center justify-between gap-2">
          <CardTitle
            style={{ fontFamily: "var(--font-display)" }}
            className="flex items-center gap-2 text-sm tracking-wide text-starlight-agy"
          >
            <Sparkles className="size-4 text-starlight-arcane" />
            {sourceMeta("agy").label}
          </CardTitle>
          {singleFreshAge !== null ? (
            <span className="text-[11px] text-muted-foreground">✦ {formatAge(singleFreshAge)}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pl-30 pr-4 sm:pl-36">
        {subjects.length === 0 ? (
          <p className="rounded-xl border border-dashed border-starlight-gold/25 px-3 py-4 text-center text-xs text-muted-foreground">
            No Google AI Subs quota observations yet.
          </p>
        ) : (
          subjects.map((subject) => {
            const groups = windowGroups(subject);
            const primaryGroups = groups.filter((group) => !/claude/i.test(group.bucketId));
            const secondaryGroups = groups.filter((group) => /claude/i.test(group.bucketId));
            const secondaryHasAlert = secondaryGroups.some((group) =>
              group.windows.some(
                (window) => window.status === "limited" || window.status === "unknown",
              ),
            );
            return (
              <div key={`${subject.source}-${subject.account}`} className="space-y-2">
                {showAccount || subject.latest_valid?.is_stale ? (
                  <SubjectMetaRow subject={subject} showAccount={showAccount} />
                ) : null}
                <AttemptWarning attempt={subject.latest_attempt} />
                <AnomalyWarning subject={subject} />
                {groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No valid quota windows.</p>
                ) : (
                  <div className="flex min-w-0 flex-col gap-2">
                    {primaryGroups.map((group) => renderBucketWindows(subject, group))}
                    {secondaryGroups.length > 0 ? (
                      <details
                        open={secondaryHasAlert || undefined}
                        className="rounded-lg border border-starlight-gold/15 bg-starlight-abyss/65 px-2.5 py-1.5 text-xs"
                      >
                        <summary className="cursor-pointer text-[11px] text-muted-foreground">
                          Other models ({secondaryGroups.length})
                        </summary>
                        <div className="mt-2 flex flex-col gap-2">
                          {secondaryGroups.map((group) => renderBucketWindows(subject, group))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function OpenCodeKeyCard({ subject, isTightest }: { subject: QuotaSubject; isTightest: boolean }) {
  const valid = subject.latest_valid;
  const windows = valid?.windows ?? [];
  return (
    <div
      className={cn(
        "min-w-0 space-y-2 rounded-xl border border-starlight-gold/22 bg-starlight-veil/85 px-3.5 py-2.5",
        isTightest &&
          "border-pink-400/60 bg-gradient-to-r from-pink-500/18 via-starlight-gradient-mid/92 to-violet-500/18 shadow-[0_0_24px_-8px_rgba(244,114,182,0.55)]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium text-starlight-mist">
            {subject.account}
          </span>
          {isTightest ? (
            <Badge
              variant="outline"
              className="rounded-full border-pink-400/65 bg-pink-500/25 px-2 py-0 text-[10px] text-pink-200"
            >
              <Sparkles className="size-2.5" />
              Tightest
            </Badge>
          ) : null}
          {valid?.is_stale ? (
            <Badge
              variant="outline"
              className="rounded-full border-amber-400/40 bg-amber-500/15 px-2 py-0 text-[10px] text-amber-200"
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
            <DiamondManaRow key={`${window.bucket_id}-${window.slot}`} window={window} />
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
    <Card className="relative mt-5 min-w-0 gap-3 overflow-visible py-4">
      <CharacterCutout
        src="/mascot-deepseek.png"
        glowFilter="drop-shadow(0 0 14px rgba(56, 189, 248, 0.5))"
        className="absolute -top-9 left-3 z-20 h-24 w-24 sm:-top-10 sm:h-28 sm:w-28"
      />
      <CardHeader className="pl-28 pr-4 pb-0 sm:pl-32">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle
              style={{ fontFamily: "var(--font-display)" }}
              className="flex items-center gap-2 text-sm tracking-wide text-starlight-opencode"
            >
              {sourceMeta("opencode").label}
            </CardTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              DeepSeek · {subjects.length} active {subjects.length === 1 ? "key" : "keys"} · 7d
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 px-4 pt-1">
        {subjects.length === 0 ? (
          <p className="rounded-xl border border-dashed border-starlight-gold/25 px-3 py-3 text-xs text-muted-foreground">
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
  const subjects = quota.subjects;
  const codex = subjects.filter((subject) => subject.source === "codex");
  const agy = subjects.filter((subject) => subject.source === "agy");
  const opencode = subjects.filter((subject) => subject.source === "opencode");

  return (
    <div className="space-y-3.5">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChatGPTSubsCard subjects={codex} />
        <GoogleAISubsCard subjects={agy} />
      </div>
      <OpenCodeOverview subjects={opencode} />
    </div>
  );
}
