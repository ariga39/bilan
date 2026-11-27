import { describe, expect, it } from "vitest";

import { buildPopulatedDaily, buildPopulatedOverview, FIXTURE_MONTH } from "@/stories/fixtures";
import { resolveStorybookScenario, STORYBOOK_SCENARIOS } from "@/stories/fetch-mock";

describe("Storybook fixtures", () => {
  it("returns usage rows only for the fixture month while keeping live balances and quotas", () => {
    const current = buildPopulatedOverview("UTC", FIXTURE_MONTH);
    expect(current.usage.rows.length).toBeGreaterThan(0);
    expect(current.usage.latest_bucket_start).not.toBeNull();
    expect(current.quotas.subjects.length).toBeGreaterThan(0);
    expect(current.balances.length).toBeGreaterThan(0);

    const otherMonth = buildPopulatedOverview("UTC", "2026-10");
    expect(otherMonth.usage.month).toBe("2026-10");
    expect(otherMonth.usage.rows).toEqual([]);
    expect(otherMonth.usage.latest_bucket_start).toBeNull();
    expect(otherMonth.usage.data_age_seconds).toBeNull();
    expect(otherMonth.usage.source_freshness).toEqual([]);
    expect(otherMonth.quotas.subjects).toEqual(current.quotas.subjects);
    expect(otherMonth.balances).toEqual(current.balances);

    expect(buildPopulatedDaily("UTC", FIXTURE_MONTH).rows.length).toBeGreaterThan(0);
    expect(buildPopulatedDaily("UTC", "2026-10").rows).toEqual([]);
  });
});

describe("Storybook scenario vocabulary", () => {
  it("accepts the shared scenarios and defaults only when the parameter is omitted", () => {
    expect(resolveStorybookScenario(undefined)).toBe("populated");
    for (const scenario of STORYBOOK_SCENARIOS) {
      expect(resolveStorybookScenario(scenario)).toBe(scenario);
    }
  });

  it("rejects unknown scenario values instead of silently showing populated", () => {
    expect(() => resolveStorybookScenario("november")).toThrow(
      /Unknown Bilan Storybook scenario "november"/u,
    );
    expect(() => resolveStorybookScenario(42)).toThrow(/Unknown Bilan Storybook scenario 42/u);
    expect(() => resolveStorybookScenario(null)).toThrow(/Unknown Bilan Storybook scenario null/u);
  });
});
