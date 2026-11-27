import type { OverviewResponse, ProducerHealth } from "@bilan/shared";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatSpan } from "@/lib/format";
import { cn } from "@/lib/utils";

function requiresAttention(producer: ProducerHealth): boolean {
  return (
    producer.is_stale || producer.last_status === "error" || producer.last_heartbeat_at === null
  );
}

function LivenessBadge({ producer }: { producer: ProducerHealth }) {
  if (producer.last_status === "error") {
    return (
      <Badge variant="destructive">
        <AlertTriangle />
        Error
      </Badge>
    );
  }
  if (producer.last_heartbeat_at === null) {
    return (
      <Badge variant="outline">
        <Clock3 />
        Never run
      </Badge>
    );
  }
  if (producer.is_stale) {
    return (
      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
        <Clock3 />
        Stale heartbeat
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
      <CheckCircle2 />
      Healthy
    </Badge>
  );
}

function latestDataAge(overview: OverviewResponse): string {
  const ages: Array<number> = [];
  for (const balance of overview.balances) {
    if (balance.data_age_seconds !== null) {
      ages.push(balance.data_age_seconds);
    }
  }
  for (const subject of overview.quotas.subjects) {
    for (const observation of [subject.latest_valid, subject.latest_attempt]) {
      if (
        observation?.sample_age_seconds !== null &&
        observation?.sample_age_seconds !== undefined
      ) {
        ages.push(observation.sample_age_seconds);
      }
    }
  }
  if (overview.usage.data_age_seconds !== null) {
    ages.push(overview.usage.data_age_seconds);
  }
  if (ages.length === 0) {
    return "No data sample yet";
  }
  return `Newest data sample ${formatAge(Math.min(...ages))}`;
}

function CollectorCard({ producer }: { producer: ProducerHealth }) {
  return (
    <Card className={cn("py-4", producer.last_status === "error" && "border-destructive/40")}>
      <CardHeader className="gap-1 px-4 pb-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Radio className="size-4 text-muted-foreground" />
              {producer.display_name}
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-[11px]">
              {producer.producer_id}
            </CardDescription>
          </div>
          <LivenessBadge producer={producer} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-muted-foreground">Heartbeat expected</span>
          <span>
            every {formatSpan(producer.expected_interval_seconds)} · stale after{" "}
            {formatSpan(producer.expected_interval_seconds * 2)}
          </span>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-muted-foreground">Last heartbeat</span>
          <span className="text-right">
            {formatDateTime(producer.last_heartbeat_at)} ·{" "}
            {formatAge(producer.heartbeat_age_seconds)}
          </span>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-muted-foreground">Last attempt</span>
          <span className="text-right">{formatDateTime(producer.last_attempt_at)}</span>
        </div>
        {producer.last_error ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs leading-snug text-destructive">
            {producer.last_error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function HealthSummary({ overview }: { overview: OverviewResponse }) {
  const healthy = overview.producers.filter((producer) => !requiresAttention(producer));
  const attention = overview.producers.filter(requiresAttention);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Activity className="size-4 text-muted-foreground" />
          {healthy.length} healthy {healthy.length === 1 ? "collector" : "collectors"}
        </span>
        {healthy.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {healthy.map((producer) => (
              <Badge key={producer.producer_id} variant="outline">
                {producer.display_name} · {formatAge(producer.heartbeat_age_seconds)}
              </Badge>
            ))}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">{latestDataAge(overview)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Heartbeat liveness is separate from each reading&apos;s own sample time. Data freshness is
        shown with quotas, balances, and usage.
      </p>
      {attention.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {attention.map((producer) => (
            <CollectorCard key={producer.producer_id} producer={producer} />
          ))}
        </div>
      ) : null}
      {overview.producers.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          No collector has reported yet. Liveness is tracked separately from data freshness.
        </p>
      ) : null}
    </div>
  );
}
