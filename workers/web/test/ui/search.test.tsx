import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardHref, validateDashboardSearch } from "../../src/search";
import { FIXED_NOW } from "@/stories/fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard search contract", () => {
  it("keeps linkable view, timezone and month values", () => {
    expect(
      validateDashboardSearch({ view: "usage", tz: "Asia/Kolkata", month: "2026-10" }),
    ).toEqual({ view: "usage", tz: "Asia/Kolkata", month: "2026-10" });
    expect(dashboardHref({ view: "usage", tz: "Asia/Kolkata", month: "2026-10" })).toBe(
      "/?view=usage&tz=Asia%2FKolkata&month=2026-10",
    );
  });

  it("normalizes invalid and missing values to the default view", () => {
    expect(validateDashboardSearch({ view: "other", tz: "Not/AZone", month: "2026-13" })).toEqual({
      view: "overview",
      tz: "Asia/Shanghai",
      month: "2026-11",
    });
  });
});
