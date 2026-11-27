import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usageHref, validateDashboardSearch, validateOverviewSearch } from "../../src/search";
import { FIXED_NOW } from "@/stories/fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard search contract", () => {
  it("keeps linkable timezone and month values on each route", () => {
    expect(validateDashboardSearch({ tz: "Asia/Kolkata", month: "2026-10" })).toEqual({
      tz: "Asia/Kolkata",
      month: "2026-10",
    });
    expect(usageHref({ tz: "Asia/Kolkata", month: "2026-10" })).toBe(
      "/usage?tz=Asia%2FKolkata&month=2026-10",
    );
  });

  it("normalizes invalid and missing values to the defaults", () => {
    expect(validateDashboardSearch({ tz: "Not/AZone", month: "2026-13" })).toEqual({
      tz: "Asia/Shanghai",
      month: "2026-11",
    });
  });

  it("retains only the legacy usage marker on the overview route", () => {
    expect(validateOverviewSearch({ view: "usage", tz: "Asia/Kolkata", month: "2026-10" })).toEqual(
      { view: "usage", tz: "Asia/Kolkata", month: "2026-10" },
    );
    expect(validateOverviewSearch({ view: "other", tz: "UTC", month: "2026-10" })).toEqual({
      tz: "UTC",
      month: "2026-10",
    });
    expect(validateDashboardSearch({ view: "usage", tz: "UTC", month: "2026-10" })).toEqual({
      tz: "UTC",
      month: "2026-10",
    });
  });
});
