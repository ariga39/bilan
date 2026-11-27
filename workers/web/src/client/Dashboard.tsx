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
  Wallet,
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
    <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
      {title}
    </h2>
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
  return (
    <a
      href={dashboardHref(next)}
      aria-current={current === target ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        current === target
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(next);
      }}
    >
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
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg border bg-card shadow-xs">
                <Wallet className="size-4" aria-hidden="true" />
              </div>
              <h1 className="text-lg font-semibold tracking-tight">bilan</h1>
            </div>
            <nav
              aria-label="Dashboard views"
              className="flex w-fit items-center gap-1 rounded-lg border bg-card p-0.5"
            >
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
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {formatDateTime(overview.generated_at)}
            </span>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </header>

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
              <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <CircleDollarSign className="size-3.5" aria-hidden="true" />
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
      </div>
    </div>
  );
}
