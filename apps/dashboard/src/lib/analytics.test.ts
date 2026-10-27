import { afterEach, expect, test } from "bun:test";
import { alignedRange, analyticsPath, drilldown } from "./analytics.ts";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("ranges align to UTC buckets and reject invalid or oversized selections", () => {
  expect(alignedRange("2026-10-20T01:12:00Z", "2026-10-21T02:01:00Z", "hour")).toEqual({
    from: "2026-10-20T01:00:00.000Z",
    to: "2026-10-21T03:00:00.000Z",
    granularity: "hour",
  });
  expect(() => alignedRange("2026-01-01", "2026-03-01", "day")).toThrow();
  expect(() => alignedRange("bad", "2026-03-01", "day")).toThrow();
  expect(analyticsPath("org", "project")).toBe("/projects/project/analytics");
  expect(analyticsPath()).toBe("/instance/analytics");
});

test("drill-down requests use a fixed template and exact encoded ref", async () => {
  let url: URL | undefined;
  globalThis.fetch = (async (input) => {
    url = new URL(String(input), "https://example.test");
    return Response.json({ rows: [], generatedAt: "2026-10-27T00:00:00.000Z" });
  }) as typeof fetch;
  await drilldown(
    "project",
    alignedRange("2026-10-20", "2026-10-21", "day"),
    "ref-history",
    "refs/heads/main",
  );
  expect(url?.pathname).toBe("/projects/project/analytics/drilldown");
  expect(url?.searchParams.get("ref")).toBe("refs/heads/main");
  expect(url?.searchParams.get("template")).toBe("ref-history");
  expect(url?.searchParams.has("granularity")).toBe(false);
});
