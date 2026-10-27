/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs migrated SQLite-backed services. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AnalyticsQuery, AnalyticsQueryLive } from "./query.ts";
import {
  AnalyticsDrilldowns,
  AnalyticsDrilldownsLive,
  AnalyticsQueryCache,
  analyticsDrilldownSql,
} from "./drilldown.ts";
import { AnalyticsError } from "./emitter.ts";
import { BasinSqlClient } from "./rollups.ts";

const from = "2026-10-25T00:00:00.000Z";
const to = "2026-10-26T00:00:00.000Z";
const hour = Date.parse(from);
const scope = { orgId: "o", projectId: "p" };
const query = { from, to, granularity: "hour" } as const;

test("D1 reads isolate tenants, combine rates from counts and prefer published data over lite counters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((q) => [
        q.insert(schema.usageHourly).values([
          {
            ...scope,
            hour,
            source: "cache",
            dimension: "",
            metrics: { requests: 4, remoteHits: 1, remoteMisses: 3, timeSavedMs: 42 },
          },
          {
            orgId: "other",
            projectId: "foreign",
            hour,
            source: "cache",
            dimension: "",
            metrics: { requests: 999, remoteHits: 999 },
          },
        ]),
        q.insert(schema.usageDaily).values({
          ...scope,
          day: hour,
          dimension: "",
          metrics: { requests: 4, remoteHits: 1, remoteMisses: 3 },
        }),
        q.insert(schema.rollup).values([
          { ...scope, bucketStart: hour, metric: "remoteHits", value: 100 },
          { ...scope, bucketStart: hour + 3_600_000, metric: "remoteHits", value: 2 },
          { ...scope, bucketStart: hour + 3_600_000, metric: "requests", value: 2 },
        ]),
        q.insert(schema.projectUsage).values([
          { ...scope, bytes: 100 },
          { orgId: "other", projectId: "foreign", bytes: 999 },
        ]),
      ]);
      const service = yield* AnalyticsQuery;
      const org = yield* service.read({ orgId: "o" }, query);
      expect(org.totals.requests).toBe(6);
      expect(org.totals.remoteHits).toBe(3);
      expect(org.totals.hitRate).toBe(0.5);
      expect(org.totals.storageBytes).toBe(100);
      expect(org.series).toHaveLength(24);
      expect(org.breakdowns.map((row) => row.id)).toEqual(["p"]);
      const daily = yield* service.read(scope, { ...query, granularity: "day" });
      expect(daily.totals.remoteHits).toBe(3);
      const instance = yield* service.read({}, query);
      expect(instance.totals.storageBytes).toBe(1099);
      expect(instance.breakdowns.some((row) => row.kind === "org" && row.id === "other")).toBe(
        true,
      );
      expect(
        (yield* service.read(scope, { ...query, to: "2027-01-01T00:00:00Z" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(
      Effect.provide(AnalyticsQueryLive.pipe(Layer.provideMerge(DatabaseTest))),
      Effect.scoped,
    ),
  );
});

test("drill-down templates always constrain tenant, range and limit and reject SQL syntax in values", () => {
  for (const template of ["most-missed", "slowest-tasks", "edge-cache", "ref-history"] as const) {
    const sql = analyticsDrilldownSql(scope, {
      from,
      to,
      template,
      ref: "refs/heads/main",
      limit: 10,
    });

    expect(sql).toContain("org_id = 'o' AND project_id = 'p'");
    expect(sql).toContain("PARTITION BY event_id");
    expect(sql).toContain("LIMIT 10");
    expect(sql).not.toContain("SELECT *");
  }

  for (const patch of [
    { ref: "main' OR 1=1 --" },
    { limit: 1000 },
    { to: "2027-01-01T00:00:00Z" },
    { template: "free-sql" },
  ]) {
    expect(() =>
      analyticsDrilldownSql(scope, {
        from,
        to,
        template: "ref-history",
        ref: "main",
        limit: 10,
        ...patch,
      }),
    ).toThrow();
  }

  expect(() =>
    analyticsDrilldownSql(
      { ...scope, orgId: "'" },
      { from, to, template: "edge-cache", limit: 10 },
    ),
  ).toThrow();
});

test("drill-down cache is tenant-specific, validates results and tolerates KV failures", async () => {
  let calls = 0;
  const cache = new Map<string, string>();

  const layer = AnalyticsDrilldownsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BasinSqlClient, {
          query: () => {
            calls++;

            return Effect.succeed([
              { hash: "abc", requests: 2.2, misses: 1.2, durationMs: 4.2, bytes: 0 },
            ]);
          },
        }),
        Layer.succeed(AnalyticsQueryCache, {
          get: (key) => Effect.sync(() => cache.get(key) ?? null),
          put: (key, value) =>
            Effect.sync(() => {
              cache.set(key, value);
            }),
        }),
      ),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AnalyticsDrilldowns;
      const query = { from, to, template: "most-missed", limit: 10 };
      expect((yield* service.read(scope, query)).rows[0]?.requests).toBe(2);
      yield* service.read(scope, query);
      expect(calls).toBe(1);
      yield* service.read({ ...scope, orgId: "other" }, query);
      expect(calls).toBe(2);
      expect(cache.size).toBe(2);

      for (const key of cache.keys()) cache.set(key, "invalid");
      yield* service.read(scope, query);
      expect(calls).toBe(3);
    }).pipe(Effect.provide(layer)),
  );
});

test("timestamp spelling is canonicalized and KV outages cannot fail a successful drill-down", async () => {
  const query = {
    from: "2026-10-25T00:00:00Z",
    to: "2026-10-26T00:00:00Z",
    template: "most-missed",
    limit: 10,
  };
  expect(analyticsDrilldownSql(scope, query)).toContain("ts >= '2026-10-25T00:00:00.000Z'");
  let failed = false;
  const layer = AnalyticsDrilldownsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BasinSqlClient, {
          query: () =>
            failed ? Effect.fail(new AnalyticsError({ cause: "offline" })) : Effect.succeed([]),
        }),
        Layer.succeed(AnalyticsQueryCache, {
          get: () => Effect.fail("KV down"),
          put: () => Effect.fail("KV down"),
        }),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AnalyticsDrilldowns;
      expect((yield* service.read(scope, query)).rows).toEqual([]);
      failed = true;
      expect((yield* service.read(scope, query).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});
