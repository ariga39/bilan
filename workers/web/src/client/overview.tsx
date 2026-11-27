import type { BalanceHistoryResponse, BalanceProvider, OverviewResponse } from "@bilan/shared";
import { Activity, AlertTriangle, CircleDollarSign, History } from "lucide-react";

import { BalanceCard } from "@/components/balance-card";
import { BalanceHistoryChart } from "@/components/balance-history-chart";
import { HealthSummary } from "@/components/health-summary";
import { QuotaOverview } from "@/components/quota-overview";
import { UsageEntry } from "@/components/usage-entry";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardSearch } from "../search";

function SectionLabel({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-starlight-gold"
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h2>
      <span
        aria-hidden="true"
        className="h-px flex-1 bg-gradient-to-r from-starlight-gold/35 via-starlight-rose/25 to-transparent"
      />
      <span aria-hidden="true" className="text-[10px] text-starlight-gold/65">
        ☽ ✦
      </span>
    </div>
  );
}

function HistorySection({
  providers,
  histories,
  loading,
  error,
}: {
  providers: Array<BalanceProvider>;
  histories: Partial<Record<BalanceProvider, BalanceHistoryResponse>>;
  loading: boolean;
  error: string | null;
}) {
  if (providers.length === 0) {
    return null;
  }
  const series = providers.flatMap((provider) =>
    (histories[provider]?.series ?? []).map((item) => ({ provider, series: item })),
  );
  return (
    <section className="min-w-0">
      <SectionLabel icon={History} title="Balance history (30d)" />
      {error && series.length > 0 ? (
        <p
          role="alert"
          className="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error} Showing cached history.
        </p>
      ) : null}
      {series.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {series.map(({ provider, series: item }) => (
            <BalanceHistoryChart
              key={`${provider}-${item.account}-${item.currency}`}
              provider={provider}
              series={item}
            />
          ))}
        </div>
      ) : loading ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          Loading 30-day balance history…
        </p>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          {error ?? "No balance history yet."}
        </p>
      )}
    </section>
  );
}

export function OverviewDashboard({
  search,
  overview,
  histories,
  historyLoading = false,
  historyError = null,
  refreshError = null,
  onOpenUsage,
}: {
  search: DashboardSearch;
  overview: OverviewResponse;
  histories: Partial<Record<BalanceProvider, BalanceHistoryResponse>>;
  historyLoading?: boolean;
  historyError?: string | null;
  refreshError?: string | null;
  onOpenUsage: () => void;
}) {
  const historyProviders = [...new Set(overview.balances.map((balance) => balance.provider))];

  return (
    <>
      {refreshError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {refreshError}
        </div>
      ) : null}

      <section className="min-w-0">
        <QuotaOverview quota={overview.quotas} />
      </section>

      <UsageEntry overview={overview} navigation={search} onOpenUsage={onOpenUsage} />

      {overview.balances.length > 0 ? (
        <section className="min-w-0">
          <SectionLabel icon={CircleDollarSign} title="Balances" />
          <div className="grid gap-3 lg:grid-cols-2">
            {overview.balances.map((balance) => (
              <BalanceCard
                key={`${balance.provider}-${balance.account}-${balance.currency}`}
                balance={balance}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-dashed border-starlight-gold/25 bg-starlight-dusk/60 px-3.5 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CircleDollarSign className="size-3.5 text-starlight-gold/70" aria-hidden="true" />
            Balances
          </span>
          <span>Not configured</span>
        </div>
      )}

      <HistorySection
        providers={historyProviders}
        histories={histories}
        loading={historyLoading}
        error={historyError}
      />

      <section className="min-w-0">
        <SectionLabel icon={Activity} title="Collectors" />
        <HealthSummary overview={overview} />
      </section>

      {overview.producers.length === 0 && overview.balances.length === 0 ? (
        <Card className="border-dashed py-4">
          <CardContent className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" />
            No collector data has arrived yet.
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
