import type { QuotaWindow } from "@bilan/shared";
import { AlertTriangle, Clock3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import {
  effectiveRemaining,
  gemColor,
  primaryPercent,
  resetDetails,
  windowLabel,
  windowTitle,
} from "@/lib/quota";
import { cn } from "@/lib/utils";

const MANA_GEMS = 10;

const SINGLE_RING_RADIUS = 38;
const SINGLE_RING_CIRCUMFERENCE = 2 * Math.PI * SINGLE_RING_RADIUS;

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
  if (status === "unknown") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-violet-300/40 bg-violet-500/20 px-1.5 py-0 text-[10px] text-violet-200"
      >
        Unknown
      </Badge>
    );
  }
  return null;
}

/** Frameless pop-out anime character cutout grounded cleanly on its card edge. */
export function CharacterCutout({
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
      style={{ filter: glowFilter }}
    />
  );
}

/** Hero Celestial Astrolabe Ring for primary / weekly quota windows. */
export function SoulGemRing({
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
    <div className="flex min-w-0 flex-1 items-center gap-3.5 rounded-xl border border-starlight-gold/20 bg-starlight-void/85 px-3.5 py-2.5">
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
          <span className="mt-1 text-[9px] tracking-widest text-starlight-gold/85 uppercase">
            {windowLabel(window)}
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5" title={windowTitle(window)}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-starlight-lilac">
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
            className="space-y-1 border-t border-starlight-gold/15 pt-1.5"
            title={windowTitle(secondary)}
          >
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-medium text-starlight-violet-muted">
                  {windowLabel(secondary)}
                </span>
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
              className="h-1.5 w-full overflow-hidden rounded-full bg-starlight-track"
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
export function DiamondManaRow({ window }: { window: QuotaWindow }) {
  const remaining = effectiveRemaining(window);
  const reset = resetDetails(window);
  const colors = gemColor(remaining, window.status);
  return (
    <div className="min-w-0 space-y-1.5" title={windowTitle(window)}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] text-starlight-gold" aria-hidden="true">
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
        className="relative flex items-center justify-between rounded-full border border-starlight-gold/28 bg-starlight-cavern/95 px-2.5 py-1.5"
        role="progressbar"
        aria-label={`${windowLabel(window)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-starlight-gold/30 to-transparent"
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
