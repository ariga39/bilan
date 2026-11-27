import type { QuotaSubject, QuotaWindow } from "@bilan/shared";

import { formatDateTime, formatNumber, formatSpan } from "./format";

export interface SourceMeta {
  label: string;
}

export const SOURCE_META = {
  opencode: { label: "OpenCode Go" },
  codex: { label: "ChatGPT Subs" },
  agy: { label: "Google AI Subs" },
} satisfies Record<string, SourceMeta>;

const EPOCH_RESET_MS = 0;

export function sourceMeta(source: string): SourceMeta {
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

export function effectiveRemaining(window: QuotaWindow): number | null {
  if (window.remaining_percent !== null) {
    return Math.max(0, Math.min(100, window.remaining_percent));
  }
  if (window.used_percent !== null) {
    return Math.max(0, Math.min(100, 100 - window.used_percent));
  }
  return null;
}

export function primaryPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function exactPercent(value: number | null): string {
  return value === null ? "Not reported" : `${formatNumber(Number(value.toFixed(2)))}%`;
}

export interface GemPalette {
  fill: string;
  stroke: string;
  glow: string;
  text: string;
}

export function gemColor(
  remaining: number | null,
  status: QuotaWindow["status"],
  accent: "teal" | "violet" = "teal",
): GemPalette {
  if (status === "limited" || (remaining !== null && remaining <= 10)) {
    return {
      fill: "var(--starlight-ember)",
      stroke: "var(--starlight-ember-soft)",
      glow: "drop-shadow(0 0 7px rgba(251, 113, 133, 0.85))",
      text: "text-rose-300",
    };
  }
  if (status === "cooldown" || (remaining !== null && remaining <= 35)) {
    return {
      fill: "var(--starlight-amber)",
      stroke: "var(--starlight-star)",
      glow: "drop-shadow(0 0 7px rgba(252, 211, 77, 0.8))",
      text: "text-amber-200",
    };
  }
  if (accent === "violet") {
    return {
      fill: "var(--starlight-arcane)",
      stroke: "var(--starlight-lilac)",
      glow: "drop-shadow(0 0 7px rgba(192, 132, 252, 0.8))",
      text: "text-starlight-arcane-pale",
    };
  }
  return {
    fill: "var(--starlight-teal)",
    stroke: "var(--starlight-teal-soft)",
    glow: "drop-shadow(0 0 7px rgba(94, 234, 212, 0.75))",
    text: "text-starlight-mist",
  };
}

export interface ResetDetails {
  short: string | null;
  at: string | null;
}

export function resetDetails(window: QuotaWindow): ResetDetails {
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

export function windowGroups(
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

export function windowTitle(window: QuotaWindow): string {
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

export function windowLabel(window: QuotaWindow): string {
  if (window.label && window.label !== window.slot) {
    return window.label;
  }
  return window.slot;
}

export function isWeeklyWindow(window: QuotaWindow): boolean {
  const label = windowLabel(window).toLowerCase();
  return window.slot === "weekly" || label.includes("week") || label === "1w";
}

export function isFiveHourWindow(window: QuotaWindow): boolean {
  const label = windowLabel(window).toLowerCase();
  return window.slot === "five-hour" || label === "5h" || label.includes("5h");
}

export function subjectLowestRemaining(subject: QuotaSubject): number {
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
