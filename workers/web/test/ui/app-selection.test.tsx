import type { OverviewResponse, UsageBreakdownRow, UsageDailyResponse } from "@bilan/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function usageRow(actor: string): UsageBreakdownRow {
  return {
    source: "codex",
    accounting_basis: "debitmetre-audit-v1",
    unit_kind: "request",
    actor_kind: "machine",
    actor_id: actor,
    model: "gpt-5",
    effort: "high",
    unit_count: 1,
    coverage_gaps: 0,
    input_tokens: 10,
    input_counted: 1,
    cached_tokens: 0,
    cached_counted: 1,
    uncached_tokens: 10,
    uncached_counted: 1,
    cache_write_tokens: 0,
    cache_write_counted: 1,
    output_tokens: 5,
    output_counted: 1,
    reasoning_tokens: 0,
    reasoning_counted: 1,
    is_partial: false,
    partial_columns: [],
  };
}

function overviewPayload(month: string, timezone: string, actor: string): OverviewResponse {
  return {
    generated_at: "2026-11-27T12:00:00Z",
    producers: [],
    balances: [],
    usage: {
      timezone,
      month,
      bucket_attribution: "exact",
      bucket_attribution_note: null,
      latest_bucket_start: "2026-11-01T00:00:00Z",
      data_age_seconds: 60,
      is_stale: false,
      source_freshness: [
        {
          source: "codex",
          latest_bucket_start: "2026-11-01T00:00:00Z",
          data_age_seconds: 60,
          is_stale: false,
        },
      ],
      rows: [usageRow(actor)],
    },
    quotas: {
      generated_at: "2026-11-27T12:00:00Z",
      subjects: [],
    },
  };
}

function dailyPayload(month: string, timezone: string, date: string): UsageDailyResponse {
  return {
    timezone,
    month,
    bucket_attribution: "exact",
    bucket_attribution_note: null,
    rows: [
      {
        source: "codex",
        accounting_basis: "debitmetre-audit-v1",
        unit_kind: "request",
        date,
        unit_count: 1,
        coverage_gaps: 0,
        input_tokens: 10,
        input_counted: 1,
        cached_tokens: 0,
        cached_counted: 1,
        uncached_tokens: 10,
        uncached_counted: 1,
        cache_write_tokens: 0,
        cache_write_counted: 1,
        output_tokens: 5,
        output_counted: 1,
        reasoning_tokens: 0,
        reasoning_counted: 1,
        is_partial: false,
        partial_columns: [],
      },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
}

interface FetchState {
  actor: string;
  dailyDate: string;
  failOverview: boolean;
  failDaily: boolean;
  deferNextOverview: boolean;
  deferredOverviewResolve: ((response: Response) => void) | null;
  deferredOverviewMonth: string;
  deferredOverviewTimezone: string;
}

function installFetch(state: FetchState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), "https://bilan.test");
    const timezone = url.searchParams.get("tz") ?? "Asia/Shanghai";
    const month = url.searchParams.get("month") ?? "2026-11";

    if (url.pathname === "/api/v1/overview") {
      if (state.deferNextOverview) {
        state.deferNextOverview = false;
        state.deferredOverviewMonth = month;
        state.deferredOverviewTimezone = timezone;
        return new Promise<Response>((resolve) => {
          state.deferredOverviewResolve = resolve;
        });
      }
      if (state.failOverview) {
        return json({ error: "selection_failed" }, 500);
      }
      return json(overviewPayload(month, timezone, state.actor));
    }

    if (url.pathname === "/api/v1/usage/daily") {
      if (state.failDaily) {
        return json({ error: "daily_failed" }, 500);
      }
      return json(dailyPayload(month, timezone, state.dailyDate));
    }

    if (url.pathname === "/api/v1/balances/history") {
      return json({
        provider: url.searchParams.get("provider") ?? "openrouter",
        days: Number(url.searchParams.get("days") ?? "30"),
        series: [],
      });
    }

    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("App usage selection safety", () => {
  it("shows unavailable and a retry action after the initial overview fails", async () => {
    const state: FetchState = {
      actor: "machine-recovered",
      dailyDate: "2026-11-01",
      failOverview: true,
      failDaily: false,
      deferNextOverview: false,
      deferredOverviewResolve: null,
      deferredOverviewMonth: "",
      deferredOverviewTimezone: "",
    };
    installFetch(state);
    render(<App />);

    expect(await screen.findByText("Request failed (HTTP 500)")).toBeTruthy();
    expect(screen.getByText("Token usage is unavailable")).toBeTruthy();
    expect(screen.queryByText(/Loading token usage/u)).toBeNull();

    state.failOverview = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry token usage" }));

    expect(await screen.findByText("machine-recovered")).toBeTruthy();
    expect(screen.queryByText("Token usage is unavailable")).toBeNull();
  });

  it("hides old monthly and daily rows when a new selection fails to refresh", async () => {
    const state: FetchState = {
      actor: "machine-old",
      dailyDate: "2026-11-01",
      failOverview: false,
      failDaily: false,
      deferNextOverview: false,
      deferredOverviewResolve: null,
      deferredOverviewMonth: "",
      deferredOverviewTimezone: "",
    };
    installFetch(state);
    render(<App />);

    expect(await screen.findByText("machine-old")).toBeTruthy();
    expect(await screen.findByText("2026-11-01")).toBeTruthy();
    const monthInput = screen.getByLabelText<HTMLInputElement>("Month");
    const selectedMonth = nextMonth(monthInput.value);

    state.failOverview = true;
    fireEvent.change(monthInput, { target: { value: selectedMonth } });

    expect(await screen.findByText("Request failed (HTTP 500)")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(selectedMonth);
    expect(screen.queryByText("machine-old")).toBeNull();
    expect(screen.queryByText("2026-11-01")).toBeNull();
    expect(screen.getByText("Usage could not be loaded")).toBeTruthy();
  });

  it("hides old daily rows when the new monthly selection succeeds but daily fails", async () => {
    const state: FetchState = {
      actor: "machine-old",
      dailyDate: "2026-11-01",
      failOverview: false,
      failDaily: false,
      deferNextOverview: false,
      deferredOverviewResolve: null,
      deferredOverviewMonth: "",
      deferredOverviewTimezone: "",
    };
    installFetch(state);
    render(<App />);

    expect(await screen.findByText("machine-old")).toBeTruthy();
    expect(await screen.findByText("2026-11-01")).toBeTruthy();
    const monthInput = screen.getByLabelText<HTMLInputElement>("Month");
    const selectedMonth = nextMonth(monthInput.value);

    state.actor = "machine-new";
    state.dailyDate = "2026-11-02";
    state.failDaily = true;
    fireEvent.change(monthInput, { target: { value: selectedMonth } });

    expect(await screen.findByText("machine-new")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(selectedMonth);
    expect(screen.queryByText("machine-old")).toBeNull();
    expect(screen.queryByText("2026-11-01")).toBeNull();
    expect(screen.getByText("Daily usage for this selection is unavailable.")).toBeTruthy();
  });

  it("ignores a late response from an older selection after the selectors change", async () => {
    const state: FetchState = {
      actor: "machine-old",
      dailyDate: "2026-11-01",
      failOverview: false,
      failDaily: false,
      deferNextOverview: false,
      deferredOverviewResolve: null,
      deferredOverviewMonth: "",
      deferredOverviewTimezone: "",
    };
    installFetch(state);
    render(<App />);

    expect(await screen.findByText("machine-old")).toBeTruthy();
    const monthInput = screen.getByLabelText<HTMLInputElement>("Month");
    const selectedMonth = nextMonth(monthInput.value);

    state.deferNextOverview = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(state.deferredOverviewResolve).not.toBeNull();
    });

    state.actor = "machine-new";
    state.dailyDate = "2026-11-02";
    fireEvent.change(monthInput, { target: { value: selectedMonth } });
    expect(await screen.findByText("machine-new")).toBeTruthy();

    state.deferredOverviewResolve?.(
      json(
        overviewPayload(
          state.deferredOverviewMonth,
          state.deferredOverviewTimezone,
          "machine-stale",
        ),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("machine-new")).toBeTruthy();
      expect(screen.queryByText("machine-stale")).toBeNull();
      expect(screen.getByLabelText<HTMLInputElement>("Month").value).toBe(selectedMonth);
    });
  });
});
