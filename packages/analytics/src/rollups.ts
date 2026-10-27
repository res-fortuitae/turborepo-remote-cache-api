import { Database, schema } from "@repo/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { AnalyticsError } from "./emitter.ts";

export class BasinSqlClient extends Context.Service<
  BasinSqlClient,
  {
    readonly query: (sql: string) => Effect.Effect<readonly unknown[], AnalyticsError>;
  }
>()("@repo/analytics/BasinSqlClient") {}

const count = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const RollupRow = Schema.Struct({
  org_id: Schema.NonEmptyString,
  project_id: Schema.NonEmptyString,
  hour: Schema.String,
  dimension: Schema.String,
  requests: count,
  remoteHits: count,
  remoteMisses: count,
  timeSavedMs: count,
  bytesServed: count,
  bytesUploaded: count,
  uniqueSessions: count,
  ciRequests: count,
  localRequests: count,
  edgeHits: count,
  edgeMisses: count,
});
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(RollupRow).check(Schema.isMaxLength(2_000)),
);
const fields = [
  "requests",
  "remoteHits",
  "remoteMisses",
  "timeSavedMs",
  "bytesServed",
  "bytesUploaded",
  "uniqueSessions",
  "ciRequests",
  "localRequests",
  "edgeHits",
  "edgeMisses",
] as const;
export type Metrics = Record<string, number>;
export const addMetrics = (target: Metrics, source: Metrics) => {
  for (const field of fields) target[field] = (target[field] ?? 0) + (source[field] ?? 0);
  return target;
};

/** Global queries: each source table is scanned once per hour, never once per tenant. */
export const rollupSql = (kind: "cache" | "artifact", from: number, to: number) => {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from >= to ||
    to - from > 3 * 3_600_000
  )
    throw new Error("Invalid rollup window");
  const start = new Date(from).toISOString();
  const end = new Date(to).toISOString();
  const columns =
    kind === "cache"
      ? "session_id, source, event, duration_ms, repo_id, ref"
      : "operation, status, bytes, edge_cache";
  const metrics =
    kind === "cache"
      ? `SUM(CASE WHEN source = 'REMOTE' THEN 1.0/sample_rate ELSE 0 END) AS requests,
       SUM(CASE WHEN source = 'REMOTE' AND event = 'HIT' THEN 1.0/sample_rate ELSE 0 END) AS "remoteHits",
       SUM(CASE WHEN source = 'REMOTE' AND event = 'MISS' THEN 1.0/sample_rate ELSE 0 END) AS "remoteMisses",
       SUM(CASE WHEN source = 'REMOTE' AND event = 'HIT' THEN duration_ms/sample_rate ELSE 0 END) AS "timeSavedMs",
       0 AS "bytesServed", 0 AS "bytesUploaded", approx_distinct(session_id) AS "uniqueSessions",
       SUM(CASE WHEN ci_provider <> 'local' THEN 1.0/sample_rate ELSE 0 END) AS "ciRequests",
       SUM(CASE WHEN ci_provider = 'local' THEN 1.0/sample_rate ELSE 0 END) AS "localRequests",
       0 AS "edgeHits", 0 AS "edgeMisses"`
      : `0 AS requests, 0 AS "remoteHits", 0 AS "remoteMisses", 0 AS "timeSavedMs",
       SUM(CASE WHEN operation = 'GET' AND status >= 200 AND status < 300 THEN bytes/sample_rate ELSE 0 END) AS "bytesServed",
       SUM(CASE WHEN operation = 'PUT' AND status = 202 THEN bytes/sample_rate ELSE 0 END) AS "bytesUploaded",
       0 AS "uniqueSessions", 0 AS "ciRequests", 0 AS "localRequests",
       SUM(CASE WHEN operation = 'GET' AND edge_cache = 'HIT' THEN 1.0/sample_rate ELSE 0 END) AS "edgeHits",
       SUM(CASE WHEN operation = 'GET' AND edge_cache = 'MISS' THEN 1.0/sample_rate ELSE 0 END) AS "edgeMisses"`;
  // Totals and provider/repository/ref dimensions share the deduplicated source CTE.
  const dimension =
    kind === "cache"
      ? `concat('provider:', ci_provider, '|repo:', coalesce(repo_id, ''), '|ref:', coalesce(ref, ''))`
      : `concat('provider:', ci_provider)`;
  return `WITH dedup AS (
    SELECT event_id, ts, org_id, project_id, ci_provider, sample_rate, ${columns}
    FROM analytics.${kind === "cache" ? "cache_events" : "artifact_ops"}
    WHERE day >= '${start.slice(0, 10)}' AND day <= '${end.slice(0, 10)}'
      AND ts >= '${start}' AND ts < '${end}' AND sample_rate > 0 AND sample_rate <= 1
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ts) = 1
  )
  SELECT org_id, project_id, concat(substring(ts, 1, 13), ':00:00.000Z') AS hour, '' AS dimension, ${metrics}
  FROM dedup GROUP BY org_id, project_id, substring(ts, 1, 13)
  UNION ALL
  SELECT org_id, project_id, concat(substring(ts, 1, 13), ':00:00.000Z') AS hour, ${dimension} AS dimension, ${metrics}
  FROM dedup GROUP BY org_id, project_id, substring(ts, 1, 13), ${dimension}
  LIMIT 2001`;
};

export class AnalyticsRollups extends Context.Service<
  AnalyticsRollups,
  {
    readonly hourly: Effect.Effect<void, AnalyticsError>;
    readonly daily: Effect.Effect<void, AnalyticsError>;
  }
>()("@repo/analytics/AnalyticsRollups") {}

export const AnalyticsRollupsLive = Layer.effect(
  AnalyticsRollups,
  Effect.gen(function* () {
    const db = yield* Database;
    const sqlClient = yield* BasinSqlClient;
    const rebuildDaily = (from: number, to: number) =>
      Effect.gen(function* () {
        const rows = yield* db.query("Analytics.daily.read", (q) =>
          q
            .select()
            .from(schema.usageHourly)
            .where(and(gte(schema.usageHourly.hour, from), lt(schema.usageHourly.hour, to))),
        );
        const grouped = new Map<string, typeof schema.usageDaily.$inferInsert>();
        for (const row of rows) {
          const day = Math.floor(row.hour / 86_400_000) * 86_400_000;
          const key = JSON.stringify([row.orgId, row.projectId, day, row.dimension]);
          const entry = grouped.get(key) ?? {
            orgId: row.orgId,
            projectId: row.projectId,
            day,
            dimension: row.dimension,
            metrics: {},
          };
          addMetrics(entry.metrics, row.metrics);
          grouped.set(key, entry);
        }
        // Keep all totals and the top 20 dimensions per project/day. Replacing removes stale top-N rows.
        const totals = [...grouped.values()].filter((row) => row.dimension === "");
        const dimensions = [...grouped.values()]
          .filter((row) => row.dimension !== "")
          .sort(
            (a, b) =>
              (b.metrics.requests ?? 0) +
              (b.metrics.bytesServed ?? 0) -
              ((a.metrics.requests ?? 0) + (a.metrics.bytesServed ?? 0)),
          );
        const counts = new Map<string, number>();
        for (const row of dimensions) {
          const key = JSON.stringify([row.orgId, row.projectId, row.day]);
          const count = counts.get(key) ?? 0;
          if (count < 20) totals.push(row);
          counts.set(key, count + 1);
        }
        // A single transaction replaces the window, including groups that have become empty.
        yield* db.batch((q) => [
          q
            .delete(schema.usageDaily)
            .where(and(gte(schema.usageDaily.day, from), lt(schema.usageDaily.day, to))),
          ...Array.from({ length: Math.ceil(totals.length / 15) }, (_, index) =>
            q.insert(schema.usageDaily).values(totals.slice(index * 15, index * 15 + 15)),
          ),
        ]);
      });
    return {
      hourly: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const to = Math.floor(now / 3_600_000) * 3_600_000;
        const from = to - 3 * 3_600_000;
        // Validate both complete responses before mutating either source's D1 window.
        const results = yield* Effect.forEach(
          ["cache", "artifact"] as const,
          (kind) => sqlClient.query(rollupSql(kind, from, to)).pipe(Effect.flatMap(decodeRows)),
          { concurrency: 1 },
        );
        const rows: (typeof schema.usageHourly.$inferInsert)[] = [];
        for (const [index, source] of (["cache", "artifact"] as const).entries()) {
          for (const row of results[index]!) {
            const hour = Date.parse(row.hour);
            if (!Number.isFinite(hour) || hour < from || hour >= to || hour % 3_600_000 !== 0)
              return yield* new AnalyticsError({ cause: "Invalid warehouse hour" });
            rows.push({
              orgId: row.org_id,
              projectId: row.project_id,
              hour,
              source,
              dimension: row.dimension,
              metrics: Object.fromEntries(fields.map((field) => [field, Math.round(row[field])])),
            });
          }
        }
        yield* db.batch((q) => [
          q
            .delete(schema.usageHourly)
            .where(and(gte(schema.usageHourly.hour, from), lt(schema.usageHourly.hour, to))),
          ...Array.from({ length: Math.ceil(rows.length / 15) }, (_, index) =>
            q.insert(schema.usageHourly).values(rows.slice(index * 15, index * 15 + 15)),
          ),
        ]);
        yield* rebuildDaily(
          Math.floor(from / 86_400_000) * 86_400_000,
          Math.ceil(to / 86_400_000) * 86_400_000,
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof AnalyticsError ? cause : new AnalyticsError({ cause }),
        ),
      ),
      daily: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const to = Math.floor(now / 86_400_000) * 86_400_000;
        yield* rebuildDaily(to - 2 * 86_400_000, to);
      }).pipe(Effect.mapError((cause) => new AnalyticsError({ cause }))),
    };
  }),
);
