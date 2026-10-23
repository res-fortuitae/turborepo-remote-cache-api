import { describe, expect, test } from "bun:test";
import { resolveResidency } from "../src/residency.ts";

describe("deployment residency", () => {
  test("omitting jurisdiction preserves automatic placement and permits optional services", () => {
    const policy = resolveResidency({});
    expect(policy.storage.jurisdiction).toBeUndefined();
    expect(policy.allowArtifactEdgeCache).toBe(true);
    expect(policy.allowKvSessionCache).toBe(true);
    expect(policy.allowBasin).toBe(true);
    expect(policy.basinDisabledReason).toBeUndefined();
  });

  test.each(["eu", "fedramp"] as const)(
    "%s restricts storage and disallows global persistence paths",
    (jurisdiction) => {
      const policy = resolveResidency({ jurisdiction });
      expect(policy.storage).toEqual({ jurisdiction });
      expect(policy.allowArtifactEdgeCache).toBe(false);
      expect(policy.allowKvSessionCache).toBe(false);
      expect(policy.allowBasin).toBe(false);
      expect(policy.basinDisabledReason).toContain("non-default jurisdiction");
      expect(policy.basinDisabledReason).toContain("D1 hourly analytics");
    },
  );

  test("invalid settings fail before resource registration instead of silently placing data", () => {
    for (const jurisdiction of ["", "EU", "us", "default", null]) {
      // Runtime validation also protects configuration edited without type checking.
      // @ts-expect-error Deliberately invalid deployment input.
      expect(() => resolveResidency({ jurisdiction })).toThrow("jurisdiction must be omitted");
    }
  });
});
