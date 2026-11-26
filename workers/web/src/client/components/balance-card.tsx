import type { BalanceProvider, BalanceView, BalanceWindowDelta } from "@bilan/shared";
import { CircleDollarSign, Clock3, Sparkles, TriangleAlert, Waves } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatAge,
  formatCurrency,
  formatDateTime,
  formatSignedCurrency,
  formatSpan,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const PROVIDER_META: Record<
  BalanceProvider,
  { label: string; icon: LucideIcon; iconClassName: string }
> = {
  openrouter: {
    label: "OpenRouter",
    icon: Sparkles,
    iconClassName: "border-violet-200 bg-violet-50 text-violet-700",
  },
  deepseek: {
    label: "DeepSeek",
    icon: Waves,
    iconClassName: "border-sky-200 bg-sky-50 text-sky-700",
  },
};

function deltaFor(balance: BalanceView, days: 7 | 30): BalanceWindowDelta | undefined {
  return balance.deltas.find((delta) => delta.window_days === days);
}

function DeltaMetric({
  label,
  value,
  currency,
  emptyLabel,
  coverage,
  actualIntervalSeconds,
  note,
  discontinuity = false,
}: {
  label: string;
  value: number | null;
  currency: string;
  emptyLabel: string;
  coverage: BalanceWindowDelta["coverage"];
  actualIntervalSeconds: number | null;
  note?: string;
  discontinuity?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {discontinuity ? (
          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
            <TriangleAlert />
            Discontinuity
          </Badge>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-1 tabular-nums",
          value === null ? "text-sm font-medium text-muted-foreground" : "text-lg font-semibold",
        )}
      >
        {value === null ? emptyLabel : formatSignedCurrency(value, currency)}
      </p>
      {coverage === "partial" ? (
        <p className="mt-0.5 text-[11px] leading-snug text-amber-700">
          Partial coverage · actual {formatSpan(actualIntervalSeconds)}
        </p>
      ) : null}
      {note ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

export function BalanceCard({ balance }: { balance: BalanceView }) {
  const meta = PROVIDER_META[balance.provider];
  const Icon = meta.icon;
  const delta7 = deltaFor(balance, 7);
  const delta30 = deltaFor(balance, 30);

  const net7Label = delta7?.coverage === "unavailable" ? "Incomplete history" : "Not reported";
  const net30Label = delta30?.coverage === "unavailable" ? "Incomplete history" : "Not reported";
  const usage7Label =
    delta7?.coverage === "unavailable" || delta7?.baseline_sampled_at === null
      ? "Incomplete history"
      : "Not reported";
  const usage30Label =
    delta30?.coverage === "unavailable" || delta30?.baseline_sampled_at === null
      ? "Incomplete history"
      : "Not reported";

  return (
    <Card className={cn("overflow-hidden", balance.is_stale && "border-amber-300/80")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg border",
                meta.iconClassName,
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="text-base">{meta.label}</CardTitle>
              <CardDescription>
                Account {balance.account} · {balance.currency}
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge variant="outline">{balance.currency}</Badge>
            {balance.is_stale ? (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                <Clock3 />
                Delayed
              </Badge>
            ) : null}
            {balance.is_available === false ? (
              <Badge variant="destructive">Unavailable</Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Remaining balance
          </p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatCurrency(balance.total_balance, balance.currency)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sampled {formatAge(balance.data_age_seconds)} · {formatDateTime(balance.sampled_at)}
          </p>
        </div>

        {balance.topped_up_balance !== null ||
        balance.granted_balance !== null ||
        balance.credit_limit !== null ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {balance.topped_up_balance !== null ? (
              <>
                <dt className="text-muted-foreground">Topped up</dt>
                <dd className="text-right font-medium tabular-nums">
                  {formatCurrency(balance.topped_up_balance, balance.currency)}
                </dd>
              </>
            ) : null}
            {balance.granted_balance !== null ? (
              <>
                <dt className="text-muted-foreground">Granted</dt>
                <dd className="text-right font-medium tabular-nums">
                  {formatCurrency(balance.granted_balance, balance.currency)}
                </dd>
              </>
            ) : null}
            {balance.credit_limit !== null ? (
              <>
                <dt className="text-muted-foreground">Credit limit</dt>
                <dd className="text-right font-medium tabular-nums">
                  {formatCurrency(balance.credit_limit, balance.currency)}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        <div className="grid gap-2.5 border-t pt-4 sm:grid-cols-2">
          <DeltaMetric
            label="Net balance change (7d)"
            value={delta7?.net_delta ?? null}
            currency={balance.currency}
            emptyLabel={net7Label}
            coverage={delta7?.coverage ?? "unavailable"}
            actualIntervalSeconds={delta7?.actual_interval_seconds ?? null}
          />
          <DeltaMetric
            label="Net balance change (30d)"
            value={delta30?.net_delta ?? null}
            currency={balance.currency}
            emptyLabel={net30Label}
            coverage={delta30?.coverage ?? "unavailable"}
            actualIntervalSeconds={delta30?.actual_interval_seconds ?? null}
          />
          {balance.provider === "openrouter" ? (
            <>
              <DeltaMetric
                label="Reported usage delta (7d)"
                value={delta7?.reported_usage_delta ?? null}
                currency={balance.currency}
                emptyLabel={usage7Label}
                coverage={delta7?.coverage ?? "unavailable"}
                actualIntervalSeconds={delta7?.actual_interval_seconds ?? null}
                note="From OpenRouter's cumulative usage field."
                discontinuity={delta7?.reported_usage_delta_discontinuity ?? false}
              />
              <DeltaMetric
                label="Reported usage delta (30d)"
                value={delta30?.reported_usage_delta ?? null}
                currency={balance.currency}
                emptyLabel={usage30Label}
                coverage={delta30?.coverage ?? "unavailable"}
                actualIntervalSeconds={delta30?.actual_interval_seconds ?? null}
                note="From OpenRouter's cumulative usage field."
                discontinuity={delta30?.reported_usage_delta_discontinuity ?? false}
              />
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function BalancesEmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <CircleDollarSign className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">No balance snapshots yet</p>
        <p className="max-w-md text-sm text-muted-foreground">
          The scheduled collector has not stored a successful balance sample. Nothing is shown as
          zero until a provider reports it.
        </p>
      </CardContent>
    </Card>
  );
}
