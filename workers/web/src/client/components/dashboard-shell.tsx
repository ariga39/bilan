import { useQueryClient, useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardSearch, DashboardView } from "../../search";

function NavLink({
  to,
  active,
  label,
  search,
}: {
  to: "/" | "/usage";
  active: boolean;
  label: string;
  search: DashboardSearch;
}) {
  return (
    <Link
      to={to}
      search={{ tz: search.tz, month: search.month }}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all",
        active
          ? "bg-gradient-to-r from-starlight-rose to-starlight-violet text-white shadow-[0_0_16px_rgba(244,114,182,0.5)]"
          : "border border-starlight-gold/20 bg-starlight-void/70 text-muted-foreground hover:border-starlight-gold/45 hover:text-foreground",
      )}
    >
      <span aria-hidden="true" className="text-[10px]">
        {active ? "✦" : "✧"}
      </span>
      {label}
    </Link>
  );
}

export function DashboardHeader({
  view,
  search,
  generatedAt = null,
  refreshing = false,
  onRefresh,
}: {
  view: DashboardView;
  search: DashboardSearch;
  generatedAt?: string | null;
  refreshing?: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="grimoire-header rounded-2xl border border-starlight-gold/35 px-4 py-3 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1
            style={{ fontFamily: "var(--font-display)" }}
            className="bg-gradient-to-r from-starlight-star via-starlight-blush to-starlight-periwinkle bg-clip-text text-xl font-bold tracking-[0.14em] text-transparent sm:text-2xl"
          >
            bilan
          </h1>
          <Sparkles className="grimoire-twinkle size-4 text-starlight-amber" aria-hidden="true" />
          <nav aria-label="Dashboard views" className="flex items-center gap-1.5">
            <NavLink to="/" active={view === "overview"} label="Overview" search={search} />
            <NavLink to="/usage" active={view === "usage"} label="Usage" search={search} />
          </nav>
        </div>

        <div className="flex items-center gap-2.5">
          {generatedAt ? (
            <span className="text-[11px] text-starlight-violet-muted">
              ☽ {formatDateTime(generatedAt)}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="rounded-full border-starlight-gold/45 bg-gradient-to-r from-[#2e1e5c] to-[#43205c] text-starlight-parchment shadow-[0_0_16px_-4px_rgba(244,114,182,0.45)] hover:from-[#3b2675] hover:to-[#542874]"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={cn("size-3.5 text-starlight-blush", refreshing && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
      </div>
    </header>
  );
}

export function DashboardPending({ label }: { label: string }) {
  return (
    <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {label}
    </p>
  );
}

export function DashboardErrorNotice({
  error,
  queryKeys,
}: {
  error: unknown;
  queryKeys: ReadonlyArray<string>;
}) {
  const message = error instanceof Error ? error.message : "The read API is unavailable.";
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  async function retry(): Promise<void> {
    setRetrying(true);
    queryErrorResetBoundary.reset();
    try {
      for (const queryKey of queryKeys) {
        queryClient.removeQueries({ queryKey: [queryKey] });
      }
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="font-medium text-destructive">Dashboard data could not be loaded.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void retry();
          }}
          disabled={retrying}
        >
          <RefreshCw className={retrying ? "animate-spin" : undefined} />
          Retry
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Navigation remains available. Retry to reload the current selection.
      </p>
    </div>
  );
}
