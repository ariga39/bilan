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
        Stale
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
    const observation = subject.latest_valid;
    if (observation?.sample_age_seconds !== null && observation?.sample_age_seconds !== undefined) {
      ages.push(observation.sample_age_seconds);
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
    <Card
      className={cn("min-w-0 py-3", producer.last_status === "error" && "border-destructive/40")}
    >
      <CardHeader className="gap-0.5 px-3.5 pb-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Radio className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{producer.display_name}</span>
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              {producer.producer_id}
            </CardDescription>
          </div>
          <LivenessBadge producer={producer} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 px-3.5 text-xs">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-muted-foreground">Last heartbeat</span>
          <span className="text-right">
            {formatDateTime(producer.last_heartbeat_at)} ·{" "}
            {formatAge(producer.heartbeat_age_seconds)}
          </span>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-muted-foreground">Expected</span>
          <span>every {formatSpan(producer.expected_interval_seconds)}</span>
        </div>
        {producer.last_error ? (
          <p className="mt-1 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-xs leading-snug text-destructive">
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
    <div className="min-w-0 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Activity className="size-3.5 text-muted-foreground" />
            {healthy.length} healthy {healthy.length === 1 ? "collector" : "collectors"}
          </span>
          {healthy.map((producer) => (
            <Badge key={producer.producer_id} variant="outline" className="text-[11px]">
              {producer.display_name} · {formatAge(producer.heartbeat_age_seconds)}
            </Badge>
          ))}
        </div>
        <span className="text-muted-foreground">{latestDataAge(overview)}</span>
      </div>
      {attention.length > 0 ? (
        <div className="grid gap-2.5 md:grid-cols-2">
          {attention.map((producer) => (
            <CollectorCard key={producer.producer_id} producer={producer} />
          ))}
        </div>
      ) : null}
      {overview.producers.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          No collectors reported yet.
        </p>
      ) : null}
    </div>
  );
}
