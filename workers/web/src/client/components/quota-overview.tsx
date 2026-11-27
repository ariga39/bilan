import type { QuotaAttempt, QuotaResponse, QuotaSubject, QuotaWindow } from "@bilan/shared";
import { filterVisibleQuotaSubjects } from "@bilan/shared";
import { AlertTriangle, Clock3, Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatNumber, formatSpan } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SourceMeta {
  label: string;
}

const SOURCE_META = {
  opencode: { label: "OpenCode Go" },
  codex: { label: "ChatGPT Subs" },
  agy: { label: "Google AI Subs" },
} satisfies Record<string, SourceMeta>;

const EPOCH_RESET_MS = 0;
const MANA_GEMS = 10;

const SINGLE_RING_RADIUS = 38;
const SINGLE_RING_CIRCUMFERENCE = 2 * Math.PI * SINGLE_RING_RADIUS;

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

interface GemPalette {
  fill: string;
  stroke: string;
  glow: string;
  text: string;
}

function gemColor(
  remaining: number | null,
  status: QuotaWindow["status"],
  accent: "teal" | "violet" = "teal",
): GemPalette {
  if (status === "limited" || (remaining !== null && remaining <= 10)) {
    return {
      fill: "#fb7185",
      stroke: "#fda4af",
      glow: "drop-shadow(0 0 7px rgba(251, 113, 133, 0.85))",
      text: "text-rose-300",
    };
  }
  if (status === "cooldown" || (remaining !== null && remaining <= 35)) {
    return {
      fill: "#fcd34d",
      stroke: "#fef08a",
      glow: "drop-shadow(0 0 7px rgba(252, 211, 77, 0.8))",
      text: "text-amber-200",
    };
  }
  if (accent === "violet") {
    return {
      fill: "#c084fc",
      stroke: "#e9d5ff",
      glow: "drop-shadow(0 0 7px rgba(192, 132, 252, 0.8))",
      text: "text-[#f3e8ff]",
    };
  }
  return {
    fill: "#5eead4",
    stroke: "#a7f3d0",
    glow: "drop-shadow(0 0 7px rgba(94, 234, 212, 0.75))",
    text: "text-[#f8f3ff]",
  };
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
        className="rounded-full border-rose-400/50 bg-rose-500/20 px-1.5 py-0 text-[10px] text-rose-200"
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
        className="rounded-full border-amber-400/50 bg-amber-500/20 px-1.5 py-0 text-[10px] text-amber-200"
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
        "rounded-lg border px-2.5 py-1.5 text-xs",
        attempt.status === "error"
          ? "border-rose-400/40 bg-rose-500/15 text-rose-200"
          : "border-amber-400/40 bg-amber-500/15 text-amber-200",
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

function isWeeklyWindow(window: QuotaWindow): boolean {
  const label = windowLabel(window).toLowerCase();
  return window.slot === "weekly" || label.includes("week") || label === "1w";
}

function isFiveHourWindow(window: QuotaWindow): boolean {
  const label = windowLabel(window).toLowerCase();
  return window.slot === "five-hour" || label === "5h" || label.includes("5h");
}

/** Frameless pop-out anime character cutout standing directly above/inside the card edge. */
function CharacterCutout({
  src,
  glowFilter,
  className,
}: {
  src: string;
  glowFilter: string;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("pointer-events-none select-none object-contain object-bottom", className)}
      style={{
        filter: glowFilter,
        maskImage: "linear-gradient(to bottom, black 82%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 82%, transparent 100%)",
      }}
    />
  );
}

/** Hero Celestial Astrolabe Ring for primary / weekly quota windows. */
function SoulGemRing({
  window,
  accent = "teal",
  titleOverride,
  secondary,
}: {
  window: QuotaWindow;
  accent?: "teal" | "violet";
  titleOverride?: string;
  secondary?: QuotaWindow | null;
}) {
  const remaining = effectiveRemaining(window);
  const reset = resetDetails(window);
  const colors = gemColor(remaining, window.status, accent);
  const offset =
    remaining === null
      ? SINGLE_RING_CIRCUMFERENCE
      : SINGLE_RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, remaining)) / 100);

  const secRemaining = secondary ? effectiveRemaining(secondary) : null;
  const secReset = secondary ? resetDetails(secondary) : null;
  const secColors = secondary ? gemColor(secRemaining, secondary.status, "teal") : null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl border border-[#f5d08a]/20 bg-[#120d28]/85 px-3.5 py-2.5">
      <div
        className="relative flex size-24 shrink-0 items-center justify-center"
        title={windowTitle(window)}
        role="progressbar"
        aria-label={`${windowLabel(window)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
      >
        <svg viewBox="0 0 96 96" className="size-full -rotate-90" aria-hidden="true">
          <circle
            cx="48"
            cy="48"
            r="44"
            fill="none"
            stroke="rgba(245, 208, 138, 0.2)"
            strokeWidth="0.9"
            strokeDasharray="2 4"
          />
          <circle
            cx="48"
            cy="48"
            r={SINGLE_RING_RADIUS}
            fill="none"
            stroke="rgba(45, 34, 86, 0.92)"
            strokeWidth="6.5"
          />
          {remaining !== null ? (
            <circle
              cx="48"
              cy="48"
              r={SINGLE_RING_RADIUS}
              fill="none"
              stroke={colors.fill}
              strokeWidth="6.5"
              strokeLinecap="round"
              strokeDasharray={SINGLE_RING_CIRCUMFERENCE}
              strokeDashoffset={offset}
              style={{ filter: colors.glow }}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            style={{ fontFamily: "var(--font-display)" }}
            className={cn("text-xl font-bold tabular-nums leading-none", colors.text)}
          >
            {primaryPercent(remaining)}
          </span>
          <span className="mt-1 text-[9px] tracking-widest text-[#f5d08a]/85 uppercase">
            {windowLabel(window)}
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5" title={windowTitle(window)}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-[#e9d5ff]">
              {titleOverride ??
                `${windowLabel(window).charAt(0).toUpperCase()}${windowLabel(window).slice(1)} window`}
            </span>
            <WindowWarningBadge status={window.status} />
          </div>
          {reset.short ? (
            <p
              className="text-xs text-muted-foreground"
              title={reset.at ? formatDateTime(reset.at) : undefined}
            >
              Resets {reset.short}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Remaining quota</p>
          )}
        </div>

        {secondary && secColors ? (
          <div
            className="space-y-1 border-t border-[#f5d08a]/15 pt-1.5"
            title={windowTitle(secondary)}
          >
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-medium text-[#d8c7f7]">{windowLabel(secondary)}</span>
                <WindowWarningBadge status={secondary.status} />
              </div>
              <div className="flex shrink-0 items-baseline gap-1.5">
                {secReset?.short ? (
                  <span
                    className="hidden text-[10px] text-muted-foreground sm:inline"
                    title={secReset.at ? formatDateTime(secReset.at) : undefined}
                  >
                    {secReset.short}
                  </span>
                ) : null}
                <span className={cn("font-bold tabular-nums", secColors.text)}>
                  {primaryPercent(secRemaining)}
                </span>
              </div>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-[#241b45]"
              role="progressbar"
              aria-label={`${windowLabel(secondary)} remaining`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={secRemaining === null ? undefined : Math.round(secRemaining)}
            >
              {secRemaining !== null ? (
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.max(0, Math.min(100, secRemaining))}%`,
                    backgroundColor: secColors.fill,
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Faceted 10-diamond Mana Crystal Gauge for OpenCode Go key rows. */
function DiamondManaRow({ window }: { window: QuotaWindow }) {
  const remaining = effectiveRemaining(window);
  const reset = resetDetails(window);
  const colors = gemColor(remaining, window.status);
  return (
    <div className="min-w-0 space-y-1.5" title={windowTitle(window)}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] text-[#f5d08a]" aria-hidden="true">
            ✧
          </span>
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
          <span className={cn("w-9 text-right text-sm font-bold tabular-nums", colors.text)}>
            {primaryPercent(remaining)}
          </span>
        </div>
      </div>
      <div
        className="relative flex items-center justify-between rounded-full border border-[#f5d08a]/28 bg-[#0f0a22]/95 px-2.5 py-1.5"
        role="progressbar"
        aria-label={`${windowLabel(window)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-[#f5d08a]/30 to-transparent"
        />
        {Array.from({ length: MANA_GEMS }, (_, index) => {
          const segStart = index * (100 / MANA_GEMS);
          const segFill =
            remaining === null
              ? 0
              : Math.max(0, Math.min(1, (remaining - segStart) / (100 / MANA_GEMS)));
          const active = segFill > 0.05;
          return (
            <svg
              key={index}
              viewBox="0 0 16 16"
              className="relative z-10 size-3.5 shrink-0"
              style={active ? { filter: colors.glow, opacity: 0.45 + segFill * 0.55 } : undefined}
              aria-hidden="true"
            >
              <polygon
                points="8,1 14,8 8,15 2,8"
                fill={active ? colors.fill : "rgba(38, 28, 74, 0.92)"}
                stroke={active ? colors.stroke : "rgba(245, 208, 138, 0.3)"}
                strokeWidth="1.2"
              />
              {active ? (
                <polygon points="8,3.2 10.5,8 8,9.5 5.5,8" fill="rgba(255,255,255,0.45)" />
              ) : null}
            </svg>
          );
        })}
      </div>
    </div>
  );
}

function ChatGPTSubsCard({ subjects }: { subjects: Array<QuotaSubject> }) {
  const sampleAge = subjects[0]?.latest_valid?.sample_age_seconds ?? null;
  const windows = subjects.flatMap((subject) =>
    (subject.latest_valid?.windows ?? []).map((window) => ({ subject, window })),
  );

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
            className="flex items-center gap-2 text-sm tracking-wide text-[#f1f5f9]"
          >
            <Sparkles className="size-4 text-[#e2e8f0]" />
            {sourceMeta("codex").label}
          </CardTitle>
          {sampleAge !== null ? (
            <span className="text-[11px] text-muted-foreground">✦ {formatAge(sampleAge)}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pl-30 pr-4 sm:pl-36">
        {subjects.map((subject) => (
          <div key={`${subject.source}-${subject.account}`} className="space-y-1.5">
            <AttemptWarning attempt={subject.latest_attempt} />
            <AnomalyWarning subject={subject} />
          </div>
        ))}
        {windows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#f5d08a]/25 px-3 py-4 text-center text-xs text-muted-foreground">
            No ChatGPT Subs quota observations yet.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {windows.map(({ subject, window }) => (
              <SoulGemRing
                key={`codex-${subject.account}-${window.bucket_id}-${window.slot}`}
                window={window}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GoogleAISubsCard({ subjects }: { subjects: Array<QuotaSubject> }) {
  const sampleAge = subjects[0]?.latest_valid?.sample_age_seconds ?? null;

  const visibleBuckets = subjects.flatMap((subject) =>
    windowGroups(subject)
      .filter((group) => !/claude/i.test(group.bucketId))
      .map((group) => ({ subject, group })),
  );

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
            className="flex items-center gap-2 text-sm tracking-wide text-[#ddd6fe]"
          >
            <Sparkles className="size-4 text-[#c084fc]" />
            {sourceMeta("agy").label}
          </CardTitle>
          {sampleAge !== null ? (
            <span className="text-[11px] text-muted-foreground">✦ {formatAge(sampleAge)}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pl-30 pr-4 sm:pl-36">
        {subjects.map((subject) => (
          <div key={`${subject.source}-${subject.account}`} className="space-y-1.5">
            <AttemptWarning attempt={subject.latest_attempt} />
            <AnomalyWarning subject={subject} />
          </div>
        ))}
        {visibleBuckets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#f5d08a]/25 px-3 py-4 text-center text-xs text-muted-foreground">
            No Google AI Subs quota observations yet.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {visibleBuckets.map(({ subject, group }) => {
              const weekly = group.windows.find(isWeeklyWindow);
              const fiveHour = group.windows.find(isFiveHourWindow);
              if (weekly && fiveHour) {
                return (
                  <SoulGemRing
                    key={`agy-${subject.account}-${group.bucketId}`}
                    window={weekly}
                    accent="violet"
                    titleOverride={group.bucketId}
                    secondary={fiveHour}
                  />
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
            })}
          </div>
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
        "min-w-0 space-y-2 rounded-xl border border-[#f5d08a]/22 bg-[#130e2b]/85 px-3.5 py-2.5",
        isTightest &&
          "border-pink-400/60 bg-gradient-to-r from-pink-500/18 via-[#1e133b]/92 to-violet-500/18 shadow-[0_0_24px_-8px_rgba(244,114,182,0.55)]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs font-medium text-[#f8f3ff]">
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
              className="flex items-center gap-2 text-sm tracking-wide text-[#bae6fd]"
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
          <p className="rounded-xl border border-dashed border-[#f5d08a]/25 px-3 py-3 text-xs text-muted-foreground">
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
    <div className="space-y-3.5">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChatGPTSubsCard subjects={codex} />
        <GoogleAISubsCard subjects={agy} />
      </div>
      <OpenCodeOverview subjects={opencode} />
    </div>
  );
}
