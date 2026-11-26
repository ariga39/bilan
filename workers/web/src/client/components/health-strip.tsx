import type { ProducerHealth } from "@bilan/shared";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge, formatDateTime, formatInterval } from "@/lib/format";
import { cn } from "@/lib/utils";

type Liveness = "healthy" | "stale" | "error" | "never";

function livenessOf(producer: ProducerHealth): Liveness {
  if (producer.last_status === "error") {
    return "error";
  }
  if (producer.last_status === "ok" && !producer.is_stale) {
    return "healthy";
  }
  if (producer.last_status === "ok") {
    return "stale";
  }
  return "never";
}

function LivenessBadge({ liveness }: { liveness: Liveness }) {
  switch (liveness) {
    case "healthy":
      return (
        <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
          <CheckCircle2 />
          Healthy
        </Badge>
      );
    case "stale":
      return (
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
          <Clock3 />
          Stale
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertTriangle />
          Error
        </Badge>
      );
    case "never":
      return (
        <Badge variant="outline">
          <Clock3 />
          Never run
        </Badge>
      );
  }
}

export function ProducerHealthCard({ producer }: { producer: ProducerHealth }) {
  const liveness = livenessOf(producer);

  return (
    <Card className={cn("gap-3 py-4", liveness === "error" && "border-destructive/40")}>
      <CardHeader className="gap-1 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Radio className="size-4 text-muted-foreground" />
              {producer.display_name}
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-[11px]">
              {producer.producer_id}
            </CardDescription>
          </div>
          <LivenessBadge liveness={liveness} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Activity className="size-3.5" />
            Heartbeat
          </span>
          <span className="text-right">
            <span className="block">{formatDateTime(producer.last_heartbeat_at)}</span>
            <span className="block text-xs text-muted-foreground">
              {formatAge(producer.heartbeat_age_seconds)}
            </span>
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Last attempt</span>
          <span className="text-right">{formatDateTime(producer.last_attempt_at)}</span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Schedule</span>
          <span>{formatInterval(producer.expected_interval_seconds)}</span>
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

export function HealthStrip({ producers }: { producers: Array<ProducerHealth> }) {
  if (producers.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <Radio className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">No collector has reported yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Producer rows appear after the first scheduled pull. Liveness is tracked separately from
            balance sample time.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {producers.map((producer) => (
        <ProducerHealthCard key={producer.producer_id} producer={producer} />
      ))}
    </div>
  );
}
