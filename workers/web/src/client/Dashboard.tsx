import type {
  BalanceHistoryResponse,
  BalanceProvider,
  OverviewResponse,
  UsageDailyResponse,
} from "@bilan/shared";
import {
  Activity,
  AlertTriangle,
  CircleDollarSign,
  History,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { BalanceCard } from "@/components/balance-card";
import { BalanceHistoryChart } from "@/components/balance-history-chart";
import { HealthSummary } from "@/components/health-summary";
import { QuotaOverview } from "@/components/quota-overview";
import { UsageEntry } from "@/components/usage-entry";
import { UsageSection } from "@/components/usage-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardSearch } from "../search";
import { dashboardHref } from "../search";

function SectionLabel({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#f5d08a]"
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h2>
      <span
        aria-hidden="true"
        className="h-px flex-1 bg-gradient-to-r from-[#f5d08a]/35 via-[#f472b6]/25 to-transparent"
      />
      <span aria-hidden="true" className="text-[10px] text-[#f5d08a]/65">
        ☽ ✦
      </span>
    </div>
  );
}

function ViewLink({
  current,
  target,
  label,
  search,
  onNavigate,
}: {
  current: DashboardSearch["view"];
  target: DashboardSearch["view"];
  label: string;
  search: DashboardSearch;
  onNavigate: (search: DashboardSearch) => void;
}) {
  const next = { ...search, view: target };
  const active = current === target;
  return (
    <a
      href={dashboardHref(next)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all",
        active
          ? "bg-gradient-to-r from-[#f472b6] to-[#a855f7] text-white shadow-[0_0_16px_rgba(244,114,182,0.5)]"
          : "border border-[#f5d08a]/20 bg-[#120d28]/70 text-muted-foreground hover:border-[#f5d08a]/45 hover:text-foreground",
      )}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(next);
      }}
    >
      <span aria-hidden="true" className="text-[10px]">
        {active ? "✦" : "✧"}
      </span>
      {label}
    </a>
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

export function DashboardLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">
      Loading overview…
    </div>
  );
}

export function Dashboard({
  search,
  overview,
  daily,
  histories,
  historyLoading = false,
  historyError = null,
  refreshError = null,
  dailyLoading = false,
  dailyError = null,
  onNavigate,
  onRefresh,
  refreshing = false,
}: {
  search: DashboardSearch;
  overview: OverviewResponse;
  daily: UsageDailyResponse | null;
  histories: Partial<Record<BalanceProvider, BalanceHistoryResponse>>;
  historyLoading?: boolean;
  historyError?: string | null;
  refreshError?: string | null;
  dailyLoading?: boolean;
  dailyError?: string | null;
  onNavigate: (search: DashboardSearch) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const historyProviders = [...new Set(overview.balances.map((balance) => balance.provider))];
  const selectedDaily =
    daily && daily.timezone === search.tz && daily.month === search.month ? daily : null;

  return (
    <div className="min-h-screen overflow-x-clip">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 lg:px-8">
        <header className="grimoire-header rounded-2xl border border-[#f5d08a]/35 px-4 py-3 backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <h1
                  style={{ fontFamily: "var(--font-display)" }}
                  className="bg-gradient-to-r from-[#fef08a] via-[#f9a8d4] to-[#c4b5fd] bg-clip-text text-xl font-bold tracking-[0.14em] text-transparent sm:text-2xl"
                >
                  bilan
                </h1>
                <Sparkles className="grimoire-twinkle size-4 text-[#fcd34d]" aria-hidden="true" />
              </div>
              <nav aria-label="Dashboard views" className="flex items-center gap-1.5">
                <ViewLink
                  current={search.view}
                  target="overview"
                  label="Overview"
                  search={search}
                  onNavigate={onNavigate}
                />
                <ViewLink
                  current={search.view}
                  target="usage"
                  label="Usage"
                  search={search}
                  onNavigate={onNavigate}
                />
              </nav>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="text-[11px] text-[#d8c7f7]">
                ☽ {formatDateTime(overview.generated_at)}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full border-[#f5d08a]/45 bg-gradient-to-r from-[#2e1e5c] to-[#43205c] text-[#fef3c7] shadow-[0_0_16px_-4px_rgba(244,114,182,0.45)] hover:from-[#3b2675] hover:to-[#542874]"
                onClick={onRefresh}
                disabled={refreshing}
              >
                <RefreshCw
                  className={cn("size-3.5 text-[#f9a8d4]", refreshing && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        <main className="flex min-w-0 flex-col gap-4">
          {refreshError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {refreshError}
            </div>
          ) : null}

          {search.view === "overview" ? (
            <>
              <section className="min-w-0">
                <QuotaOverview quota={overview.quotas} />
              </section>

              <UsageEntry overview={overview} navigation={search} onNavigate={onNavigate} />

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
                <div className="flex items-center justify-between rounded-xl border border-dashed border-[#f5d08a]/25 bg-[#161130]/60 px-3.5 py-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <CircleDollarSign className="size-3.5 text-[#f5d08a]/70" aria-hidden="true" />
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
            </>
          ) : (
            <UsageSection
              usage={
                overview.usage.timezone === search.tz && overview.usage.month === search.month
                  ? overview.usage
                  : null
              }
              daily={selectedDaily}
              timezone={search.tz}
              month={search.month}
              generatedAt={overview.generated_at}
              dailyLoading={dailyLoading}
              dailyError={dailyError}
              onTimezoneChange={(tz) => {
                onNavigate({ ...search, tz });
              }}
              onMonthChange={(month) => {
                onNavigate({ ...search, month });
              }}
            />
          )}

          {overview.producers.length === 0 && overview.balances.length === 0 ? (
            <Card className="border-dashed py-4">
              <CardContent className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
                <AlertTriangle className="size-4" />
                No collector data has arrived yet.
              </CardContent>
            </Card>
          ) : null}
        </main>
      </div>
    </div>
  );
}
