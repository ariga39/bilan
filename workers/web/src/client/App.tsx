import { BALANCE_PROVIDERS } from "@bilan/shared";
import type { BalanceHistoryResponse, BalanceProvider, OverviewResponse } from "@bilan/shared";
import {
  Activity,
  AlertTriangle,
  CircleDollarSign,
  History,
  LockKeyhole,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";

import { BalanceCard, BalancesEmptyState } from "@/components/balance-card";
import { BalanceHistoryChart } from "@/components/balance-history-chart";
import { HealthStrip } from "@/components/health-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchBalanceHistory, fetchOverview } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL_MS = 60_000;

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-2.5">
      <div className="mt-0.5 flex size-7 items-center justify-center rounded-md border bg-card text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Card className="border-destructive/30 bg-destructive/5 py-4">
      <CardContent className="flex items-start gap-3 px-4">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-medium text-destructive">
            Dashboard data could not be fully refreshed
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function App() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [histories, setHistories] = useState<
    Partial<Record<BalanceProvider, BalanceHistoryResponse>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const nextOverview = await fetchOverview(controller.signal);
        const historyResults = await Promise.allSettled(
          BALANCE_PROVIDERS.map((provider) => fetchBalanceHistory(provider, 30, controller.signal)),
        );

        if (cancelled) {
          return;
        }

        setOverview(nextOverview);
        const nextHistories: Partial<Record<BalanceProvider, BalanceHistoryResponse>> = {};
        let historyError: string | null = null;

        historyResults.forEach((result, index) => {
          const provider = BALANCE_PROVIDERS[index];
          if (!provider) {
            return;
          }
          if (result.status === "fulfilled") {
            nextHistories[provider] = result.value;
          } else {
            historyError = "Balance history could not be loaded.";
          }
        });

        setHistories(nextHistories);
        setError(historyError);
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "The read API is unavailable.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [reloadToken]);

  const historiesToRender = BALANCE_PROVIDERS.flatMap((provider) => {
    const history = histories[provider];
    if (!history) {
      return [];
    }
    return history.series.map((series) => ({ provider, series }));
  });

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl border bg-card shadow-sm">
              <Wallet className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">bilan</h1>
              <p className="text-sm text-muted-foreground">
                Prepaid AI balances and collection health.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReloadToken((token) => token + 1);
              }}
              disabled={loading}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1">
            <LockKeyhole className="size-3.5" />
            Read-only · protected by Cloudflare Access
          </span>
          {overview ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1">
              <History className="size-3.5" />
              Generated {formatDateTime(overview.generated_at)}
            </span>
          ) : null}
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        <section>
          <SectionHeading
            icon={Activity}
            title="Collection health"
            description="Heartbeat liveness is shown separately from each balance sample's own timestamp."
          />
          <HealthStrip producers={overview?.producers ?? []} />
        </section>

        <section>
          <SectionHeading
            icon={CircleDollarSign}
            title="Balances"
            description="Current remaining balance per provider and currency. Changes compare balance snapshots, including top-ups and usage."
          />
          {overview && overview.balances.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {overview.balances.map((balance) => (
                <BalanceCard
                  key={`${balance.provider}-${balance.account}-${balance.currency}`}
                  balance={balance}
                />
              ))}
            </div>
          ) : loading && !overview ? (
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin" />
                Loading balances…
              </CardContent>
            </Card>
          ) : (
            <BalancesEmptyState />
          )}
        </section>

        <section>
          <SectionHeading
            icon={History}
            title="Balance history"
            description="Last 30 days. Each currency gets its own series and axis; values are never combined across currencies."
          />
          {historiesToRender.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {historiesToRender.map(({ provider, series }) => (
                <BalanceHistoryChart
                  key={`${provider}-${series.account}-${series.currency}`}
                  provider={provider}
                  series={series}
                />
              ))}
            </div>
          ) : (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">No history yet</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                A history line appears after the scheduled collector has stored at least one balance
                snapshot.
              </CardContent>
            </Card>
          )}
        </section>

        <footer className="border-t pt-4 text-xs text-muted-foreground">
          Read-only surface. Balance collection runs on the write Worker schedule; this page
          refreshes every 60 seconds.
        </footer>
      </div>
    </div>
  );
}
