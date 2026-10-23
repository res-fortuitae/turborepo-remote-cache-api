import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Id, NonNegativeInteger, PositiveInteger, TimeRangeQuery, Timestamp } from "./common.ts";
import { ApiErrors } from "./http-errors.ts";
import { ApiAuthorization } from "./authorization.ts";

export const AnalyticsQuery = Schema.Struct({
  ...TimeRangeQuery.fields,
  granularity: Schema.Literals(["hour", "day"]),
});

export const UsageMetrics = Schema.Struct({
  requests: NonNegativeInteger,
  remoteHits: NonNegativeInteger,
  remoteMisses: NonNegativeInteger,
  timeSavedMs: NonNegativeInteger,
  bytesServed: NonNegativeInteger,
  bytesUploaded: NonNegativeInteger,
  storageBytes: NonNegativeInteger,
  uniqueSessions: NonNegativeInteger,
});

export const UsagePoint = Schema.Struct({ ts: Timestamp, ...UsageMetrics.fields });
export const UsageBreakdown = Schema.Struct({ id: Id, ...UsageMetrics.fields });

export const AnalyticsResponse = Schema.Struct({
  totals: UsageMetrics,
  series: Schema.Array(UsagePoint),
  breakdowns: Schema.Array(UsageBreakdown),
});

export const AnalyticsDrilldownQuery = Schema.Struct({
  ...TimeRangeQuery.fields,
  template: Schema.Literals(["most-missed", "slowest-tasks", "edge-cache", "ref-history"]),
  ref: Schema.optional(Schema.NonEmptyString),
  limit: PositiveInteger.check(Schema.isLessThanOrEqualTo(100)),
});

export const AnalyticsDrilldownRow = Schema.Struct({
  hash: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  requests: NonNegativeInteger,
  misses: NonNegativeInteger,
  durationMs: NonNegativeInteger,
  bytes: NonNegativeInteger,
});

export const AnalyticsDrilldownResponse = Schema.Struct({
  rows: Schema.Array(AnalyticsDrilldownRow),
  generatedAt: Timestamp,
});

export const AnalyticsApi = HttpApiGroup.make("analytics")
  .add(
    HttpApiEndpoint.get("org", "/orgs/:id/analytics", {
      params: { id: Id },
      query: AnalyticsQuery,
      success: AnalyticsResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("project", "/projects/:id/analytics", {
      params: { id: Id },
      query: AnalyticsQuery,
      success: AnalyticsResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("instance", "/instance/analytics", {
      query: AnalyticsQuery,
      success: AnalyticsResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("drilldown", "/projects/:id/analytics/drilldown", {
      params: { id: Id },
      query: AnalyticsDrilldownQuery,
      success: AnalyticsDrilldownResponse,
      error: ApiErrors,
    }),
  )
  .middleware(ApiAuthorization);

export type AnalyticsResponse = typeof AnalyticsResponse.Type;
