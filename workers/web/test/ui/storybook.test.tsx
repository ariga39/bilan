import { dashboardQuotaSubjects } from "@bilan/shared";
import { describe, expect, it } from "vitest";

import {
  buildEmptyDaily,
  buildEmptyOverview,
  buildPopulatedDaily,
  buildPopulatedOverview,
  FIXED_NOW,
  FIXTURE_MONTH,
} from "@/stories/fixtures";

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

  it("keeps the nine-key fixture to the three recently reporting OpenCode keys", () => {
    const subjects = buildPopulatedOverview("UTC", FIXTURE_MONTH).quotas.subjects;
    const projected = dashboardQuotaSubjects(subjects, new Date(FIXED_NOW));
    const visible = projected.filter((subject) => subject.source === "opencode");
    expect(subjects.filter((subject) => subject.source === "opencode")).toHaveLength(9);
    expect(visible.map((subject) => subject.account)).toEqual(["Go#1", "Go#2", "Go#3"]);
    expect(visible.find((subject) => subject.account === "Go#3")?.latest_attempt?.status).toBe(
      "error",
    );
    expect(visible.some((subject) => subject.account === "Go#4")).toBe(false);
    expect(JSON.stringify(projected)).not.toMatch(/key-fp-/u);
  });

  it.each([
    { timezone: "UTC", attribution: "exact", approximate: false },
    { timezone: "Asia/Kolkata", attribution: "approximate", approximate: true },
  ])(
    "derives $timezone bucket attribution for populated and empty overview and daily responses",
    ({ timezone, attribution, approximate }) => {
      const overviews = [
        buildPopulatedOverview(timezone, FIXTURE_MONTH),
        buildEmptyOverview(timezone, FIXTURE_MONTH),
      ];
      const dailies = [
        buildPopulatedDaily(timezone, FIXTURE_MONTH),
        buildEmptyDaily(timezone, FIXTURE_MONTH),
      ];

      for (const response of [...overviews.map((overview) => overview.usage), ...dailies]) {
        expect(response.bucket_attribution).toBe(attribution);
        if (approximate) {
          expect(response.bucket_attribution_note).toContain("Asia/Kolkata");
        } else {
          expect(response.bucket_attribution_note).toBeNull();
        }
      }
    },
  );
});
