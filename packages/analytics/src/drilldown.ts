import { AnalyticsDrilldownQuery, AnalyticsDrilldownResponse, BadRequest } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { AnalyticsError, type AnalyticsScope } from "./emitter.ts";
import { BasinSqlClient } from "./rollups.ts";

export class AnalyticsQueryCache extends Context.Service<
  AnalyticsQueryCache,
  {
    readonly get: (key: string) => Effect.Effect<string | null, unknown>;
    readonly put: (key: string, value: string, ttl: number) => Effect.Effect<void, unknown>;
  }
>()("@repo/analytics/AnalyticsQueryCache") {}

const decodeQuery = Schema.decodeUnknownSync(AnalyticsDrilldownQuery);
const decodeResponse = Schema.decodeUnknownEffect(AnalyticsDrilldownResponse);
const identifier = /^[A-Za-z0-9_:-]{1,128}$/;
const refPattern = /^[A-Za-z0-9_./@:-]{1,256}$/;

const validate = (scope: AnalyticsScope, input: unknown) => {
  const query = decodeQuery(input);

  if (
    !identifier.test(scope.orgId) ||
    !identifier.test(scope.projectId) ||
    Date.parse(query.from) >= Date.parse(query.to) ||
    Date.parse(query.to) - Date.parse(query.from) > 30 * 86_400_000 ||
    (query.ref !== undefined && !refPattern.test(query.ref)) ||
    (query.template === "ref-history" && query.ref === undefined)
  )
    throw new BadRequest({ message: "Invalid drill-down scope or range (maximum 30 days)" });

  return {
    ...query,
    from: new Date(query.from).toISOString(),
    to: new Date(query.to).toISOString(),
  };
};

/** No user-controlled identifiers, operators or projections enter the query. */
export const analyticsDrilldownSql = (scope: AnalyticsScope, input: unknown) => {
  const query = validate(scope, input);
  const edge = query.template === "edge-cache";
  const conditions = `org_id = '${scope.orgId}' AND project_id = '${scope.projectId}' AND day >= '${query.from.slice(0, 10)}' AND day <= '${query.to.slice(0, 10)}' AND ts >= '${query.from}' AND ts < '${query.to}' AND sample_rate > 0 AND sample_rate <= 1`;

  const columns = edge
    ? "event_id, ts, hash, operation, status, bytes, edge_cache, sample_rate"
    : "event_id, ts, hash, ref, source, event, duration_ms, sample_rate";

  const dedup = `WITH dedup AS (SELECT ${columns} FROM analytics.${edge ? "artifact_ops" : "cache_events"} WHERE ${conditions}${query.ref && !edge ? ` AND ref = '${query.ref}'` : ""} QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ts) = 1)`;

  if (edge)
    return `${dedup} SELECT hash, SUM(1.0/sample_rate) AS requests, 0 AS misses, 0 AS "durationMs", SUM(CASE WHEN status >= 200 AND status < 300 THEN bytes/sample_rate ELSE 0 END) AS bytes, SUM(CASE WHEN edge_cache = 'HIT' THEN 1.0/sample_rate ELSE 0 END) AS "edgeHits", SUM(CASE WHEN edge_cache = 'MISS' THEN 1.0/sample_rate ELSE 0 END) AS "edgeMisses" FROM dedup WHERE operation = 'GET' GROUP BY hash ORDER BY requests DESC LIMIT ${query.limit}`;
  const history = query.template === "ref-history";
  const ts = `concat(substring(ts,1,13), ':00:00.000Z')`;

  return `${dedup} SELECT hash${history ? `, ref, ${ts} AS ts` : ""}, SUM(1.0/sample_rate) AS requests, SUM(CASE WHEN event = 'MISS' THEN 1.0/sample_rate ELSE 0 END) AS misses, SUM(CASE WHEN event = 'HIT' THEN duration_ms/sample_rate ELSE 0 END) AS "durationMs", 0 AS bytes FROM dedup WHERE source = 'REMOTE' GROUP BY hash${history ? `, ref, ${ts}` : ""} ORDER BY ${query.template === "most-missed" ? "misses" : history ? "ts" : '"durationMs"'} DESC LIMIT ${query.limit}`;
};

export class AnalyticsDrilldowns extends Context.Service<
  AnalyticsDrilldowns,
  {
    readonly read: (
      scope: AnalyticsScope,
      input: unknown,
    ) => Effect.Effect<typeof AnalyticsDrilldownResponse.Type, BadRequest | AnalyticsError>;
  }
>()("@repo/analytics/AnalyticsDrilldowns") {}

export const AnalyticsDrilldownsLive = Layer.effect(
  AnalyticsDrilldowns,
  Effect.gen(function* () {
    const sql = yield* BasinSqlClient;
    const cache = yield* AnalyticsQueryCache;

    return {
      read: (scope, input) =>
        Effect.gen(function* () {
          const query = yield* Effect.try({
            try: () => validate(scope, input),
            catch: () => new BadRequest({ message: "Invalid drill-down filters" }),
          });

          const statement = analyticsDrilldownSql(scope, query);

          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify([scope.orgId, scope.projectId, query])),
            ),
          );

          const key = `analytics-drilldown:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* cache.get(key).pipe(Effect.catch(() => Effect.succeed(null)));

          if (cached) {
            const parsed = yield* Effect.try(() => JSON.parse(cached)).pipe(
              Effect.flatMap(decodeResponse),
              Effect.option,
            );

            if (
              parsed._tag === "Some" &&
              parsed.value.rows.length <= query.limit &&
              Date.parse(parsed.value.generatedAt) <= now &&
              now - Date.parse(parsed.value.generatedAt) < 300_000
            )
              return parsed.value;
          }

          const rows = yield* sql.query(statement);

          if (rows.length > query.limit)
            return yield* new AnalyticsError({ cause: "Drill-down exceeds limit" });

          // SQL sample weighting can return fractional counts; publish rounded estimates.
          const normalized = yield* Effect.try(() =>
            rows.map((row) => {
              const value = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                row,
              );

              return Object.fromEntries(
                Object.entries(value).map(([key, value]) => [
                  key,
                  typeof value === "number" ? Math.round(value) : value,
                ]),
              );
            }),
          );

          const result = yield* decodeResponse({
            rows: normalized,
            generatedAt: new Date(now).toISOString(),
          });

          yield* cache.put(key, JSON.stringify(result), 300).pipe(Effect.catch(() => Effect.void));

          return result;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof BadRequest || cause instanceof AnalyticsError
              ? cause
              : new AnalyticsError({ cause }),
          ),
        ),
    };
  }),
);
