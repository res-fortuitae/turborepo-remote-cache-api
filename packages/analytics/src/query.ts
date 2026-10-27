import { AnalyticsQuery as QuerySchema, AnalyticsResponse, BadRequest } from "@repo/api-spec";
import { Database, schema } from "@repo/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { AnalyticsError } from "./emitter.ts";
import { addMetrics, type Metrics } from "./rollups.ts";

export interface AnalyticsSelection {
  readonly orgId?: string;
  readonly projectId?: string;
}

const breakdownIds = (
  selection: AnalyticsSelection,
  org: string,
  project: string,
): ReadonlyArray<readonly ["org" | "project", string]> =>
  selection.orgId
    ? [["project", project]]
    : [
        ["org", org],
        ["project", project],
      ];

const decodeQuery = Schema.decodeUnknownEffect(QuerySchema);
const decodeResponse = Schema.decodeUnknownEffect(AnalyticsResponse);

const empty = (): Metrics => ({
  evictions: 0,
  evictedBytes: 0,
  requests: 0,
  remoteHits: 0,
  remoteMisses: 0,
  timeSavedMs: 0,
  bytesServed: 0,
  bytesUploaded: 0,
  storageBytes: 0,
  uniqueSessions: 0,
  ciRequests: 0,
  localRequests: 0,
  edgeHits: 0,
  edgeMisses: 0,
});

const rates = (metrics: Metrics) => ({
  ...empty(),
  ...metrics,
  hitRate:
    (metrics.remoteHits ?? 0) / ((metrics.remoteHits ?? 0) + (metrics.remoteMisses ?? 0) || 1),
  edgeCacheHitRate:
    (metrics.edgeHits ?? 0) / ((metrics.edgeHits ?? 0) + (metrics.edgeMisses ?? 0) || 1),
});

export class AnalyticsQuery extends Context.Service<
  AnalyticsQuery,
  {
    readonly read: (
      selection: AnalyticsSelection,
      input: unknown,
    ) => Effect.Effect<AnalyticsResponse, BadRequest | AnalyticsError>;
  }
>()("@repo/analytics/AnalyticsQuery") {}

/** D1 only. The warehouse client is deliberately absent from this layer's requirements. */
export const AnalyticsQueryLive = Layer.effect(
  AnalyticsQuery,
  Effect.gen(function* () {
    const db = yield* Database;

    return {
      read: (selection, input) =>
        Effect.gen(function* () {
          const query = yield* decodeQuery(input).pipe(
            Effect.mapError(() => new BadRequest({ message: "Invalid analytics range" })),
          );

          const from = Date.parse(query.from);
          const to = Date.parse(query.to);
          const step = query.granularity === "hour" ? 3_600_000 : 86_400_000;

          if (
            from >= to ||
            to - from > 31 * 86_400_000 ||
            from % step ||
            to % step ||
            (selection.projectId && !selection.orgId)
          )
            return yield* new BadRequest({
              message: "Use aligned UTC bucket boundaries and a range of at most 31 days",
            });
          const table = query.granularity === "hour" ? schema.usageHourly : schema.usageDaily;
          const bucket = "hour" in table ? table.hour : table.day;

          const rows = yield* db.query("Analytics.read", (q) =>
            q
              .select({
                orgId: table.orgId,
                projectId: table.projectId,
                bucket,
                dimension: table.dimension,
                metrics: table.metrics,
              })
              .from(table)
              .where(
                and(
                  selection.orgId ? eq(table.orgId, selection.orgId) : undefined,
                  selection.projectId ? eq(table.projectId, selection.projectId) : undefined,
                  gte(bucket, from),
                  lt(bucket, to),
                ),
              )
              .limit(20001),
          );

          const lite = yield* db.query("Analytics.lite", (q) =>
            q
              .select()
              .from(schema.rollup)
              .where(
                and(
                  selection.orgId ? eq(schema.rollup.orgId, selection.orgId) : undefined,
                  selection.projectId
                    ? eq(schema.rollup.projectId, selection.projectId)
                    : undefined,
                  gte(schema.rollup.bucketStart, from),
                  lt(schema.rollup.bucketStart, to),
                ),
              )
              .limit(20001),
          );

          const basinHours =
            query.granularity === "day"
              ? yield* db.query("Analytics.publishedHours", (q) =>
                  q
                    .select({
                      orgId: schema.usageHourly.orgId,
                      projectId: schema.usageHourly.projectId,
                      hour: schema.usageHourly.hour,
                    })
                    .from(schema.usageHourly)
                    .where(
                      and(
                        selection.orgId ? eq(schema.usageHourly.orgId, selection.orgId) : undefined,
                        selection.projectId
                          ? eq(schema.usageHourly.projectId, selection.projectId)
                          : undefined,
                        eq(schema.usageHourly.source, "cache"),
                        eq(schema.usageHourly.dimension, ""),
                        gte(schema.usageHourly.hour, from),
                        lt(schema.usageHourly.hour, to),
                      ),
                    )
                    .limit(20001),
                )
              : [];

          const storage = yield* db.query("Analytics.storage", (q) =>
            q
              .select()
              .from(schema.projectUsage)
              .where(
                and(
                  selection.orgId ? eq(schema.projectUsage.orgId, selection.orgId) : undefined,
                  selection.projectId
                    ? eq(schema.projectUsage.projectId, selection.projectId)
                    : undefined,
                ),
              )
              .limit(20001),
          );

          if (
            rows.length > 20000 ||
            lite.length > 20000 ||
            storage.length > 20000 ||
            basinHours.length > 20000
          )
            return yield* new AnalyticsError({ cause: "Analytics selection exceeds read budget" });
          const totals = empty();
          const series = new Map<number, Metrics>();

          const breakdowns = new Map<
            string,
            { id: string; kind: "org" | "project" | "dimension"; metrics: Metrics }
          >();

          const published = new Set<string>();

          const identity = (org: string, project: string, bucket: number) =>
            JSON.stringify([org, project, bucket]);

          const add = (org: string, project: string, bucket: number, metrics: Metrics) => {
            addMetrics(totals, metrics);
            const point = series.get(bucket) ?? empty();
            addMetrics(point, metrics);
            series.set(bucket, point);

            for (const [kind, id] of breakdownIds(selection, org, project)) {
              const key = JSON.stringify([kind, id]);
              const entry = breakdowns.get(key) ?? { id, kind, metrics: empty() };
              addMetrics(entry.metrics, metrics);
              breakdowns.set(key, entry);
            }
          };

          for (const row of rows) {
            if (row.dimension !== "") {
              if (selection.projectId) {
                const key = `dimension:${row.dimension}`;

                const entry = breakdowns.get(key) ?? {
                  id: row.dimension,
                  kind: "dimension" as const,
                  metrics: empty(),
                };

                addMetrics(entry.metrics, row.metrics);
                breakdowns.set(key, entry);
              }

              continue;
            }

            published.add(identity(row.orgId, row.projectId, row.bucket));
            add(row.orgId, row.projectId, row.bucket, row.metrics);
          }

          if (query.granularity === "day") {
            published.clear();

            for (const row of basinHours)
              published.add(identity(row.orgId, row.projectId, row.hour));
          }

          // Lite is retained for deployments without Basin. Published Basin buckets take precedence.
          for (const row of lite) {
            const bucket = Math.floor(row.bucketStart / step) * step;

            if (
              published.has(identity(row.orgId, row.projectId, row.bucketStart)) &&
              !["evictions", "evictedBytes"].includes(row.metric)
            )
              continue;

            if (
              ![
                "requests",
                "remoteHits",
                "remoteMisses",
                "timeSavedMs",
                "evictions",
                "evictedBytes",
              ].includes(row.metric)
            )
              continue;
            add(row.orgId, row.projectId, bucket, { [row.metric]: row.value });
          }

          for (const row of storage) {
            totals.storageBytes = (totals.storageBytes ?? 0) + row.bytes;

            for (const [kind, id] of breakdownIds(selection, row.orgId, row.projectId)) {
              const key = JSON.stringify([kind, id]);
              const entry = breakdowns.get(key) ?? { id, kind, metrics: empty() };
              entry.metrics.storageBytes = (entry.metrics.storageBytes ?? 0) + row.bytes;
              breakdowns.set(key, entry);
            }
          }

          for (let bucket = from; bucket < to; bucket += step)
            if (!series.has(bucket)) series.set(bucket, empty());

          // Storage is a gauge, not a counter. Carry each project's last observed
          // size forward within the range; never sum snapshots across hours.
          const snapshots = lite
            .filter((row) => row.metric === "storageBytes")
            .sort((a, b) => a.bucketStart - b.bucketStart);
          const latest = new Map<string, number>();
          const observed = new Set<number>();
          let snapshotIndex = 0;
          for (const [bucket, metrics] of [...series.entries()].sort(([a], [b]) => a - b)) {
            while (
              snapshotIndex < snapshots.length &&
              snapshots[snapshotIndex]!.bucketStart < bucket + step
            ) {
              const row = snapshots[snapshotIndex++]!;
              latest.set(JSON.stringify([row.orgId, row.projectId]), row.value);
            }
            if (
              storage.length > 0 &&
              storage.every((row) => latest.has(JSON.stringify([row.orgId, row.projectId])))
            ) {
              metrics.storageBytes = [...latest.values()].reduce((sum, value) => sum + value, 0);
              observed.add(bucket);
            }
          }

          return yield* decodeResponse({
            totals: rates(totals),
            series: [...series.entries()]
              .sort(([a], [b]) => a - b)
              .map(([bucket, metrics]) => ({
                ts: new Date(bucket).toISOString(),
                ...rates(metrics),
                storageObserved: observed.has(bucket),
              })),
            breakdowns: [...breakdowns.values()]
              .sort(
                (a, b) =>
                  (b.metrics.bytesServed ?? 0) +
                  (b.metrics.storageBytes ?? 0) -
                  ((a.metrics.bytesServed ?? 0) + (a.metrics.storageBytes ?? 0)),
              )
              .slice(0, 100)
              .map(({ id, kind, metrics }) => ({ id, kind, ...rates(metrics) })),
          });
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
