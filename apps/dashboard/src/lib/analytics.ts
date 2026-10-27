import { AnalyticsResponse, AnalyticsDrilldownResponse } from "@repo/shared";
import { api } from "./api.ts";

export interface AnalyticsRange {
  readonly from: string;
  readonly to: string;
  readonly granularity: "hour" | "day";
}
export const analyticsPath = (org?: string, project?: string) =>
  project
    ? `/projects/${encodeURIComponent(project)}/analytics`
    : org
      ? `/orgs/${encodeURIComponent(org)}/analytics`
      : "/instance/analytics";
export const readAnalytics = (
  org: string | undefined,
  project: string | undefined,
  range: AnalyticsRange,
  signal?: AbortSignal,
) =>
  api(`${analyticsPath(org, project)}?${new URLSearchParams({ ...range })}`, {
    schema: AnalyticsResponse,
    signal,
  });
export const drilldown = (
  project: string,
  range: AnalyticsRange,
  template: "most-missed" | "slowest-tasks" | "edge-cache" | "ref-history",
  ref: string,
  signal?: AbortSignal,
) =>
  api(
    `/projects/${encodeURIComponent(project)}/analytics/drilldown?${new URLSearchParams({ from: range.from, to: range.to, template, limit: "20", ...(template === "ref-history" ? { ref } : {}) })}`,
    { schema: AnalyticsDrilldownResponse, signal },
  );
export const alignedRange = (
  from: string,
  to: string,
  granularity: "hour" | "day",
): AnalyticsRange => {
  const step = granularity === "hour" ? 3600000 : 86400000;
  const start = Date.parse(from),
    end = Date.parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end - start > 30 * 86400000
  )
    throw new Error("Choose a date range of 1–30 days.");
  return {
    from: new Date(Math.floor(start / step) * step).toISOString(),
    to: new Date(Math.ceil(end / step) * step).toISOString(),
    granularity,
  };
};
export const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
