/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs SQLite-backed jobs. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AnalyticsError } from "./emitter.ts";
import { AnalyticsRollups, AnalyticsRollupsLive, BasinSqlClient, rollupSql } from "./rollups.ts";
import {
  AnalyticsInventory,
  StorageReconciliation,
  StorageReconciliationLive,
} from "./inventory.ts";
import { StorageAccounting, StorageAccountingLive } from "./accounting.ts";

const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const row = {
  org_id: "o",
  project_id: "p",
  hour: new Date(hour).toISOString(),
  dimension: "",
  requests: 1,
  remoteHits: 1,
  remoteMisses: 0,
  timeSavedMs: 10,
  bytesServed: 0,
  bytesUploaded: 0,
  uniqueSessions: 1,
  ciRequests: 1,
  localRequests: 0,
  edgeHits: 0,
  edgeMisses: 0,
};

test("hourly reruns replace values, late data recomputes daily totals and failures retain previous data", async () => {
  let hits = 1;
  let fail = false;
  let queries = 0;
  const sql = Layer.succeed(BasinSqlClient, {
    query: (query) => {
      queries++;
      return fail
        ? Effect.fail(new AnalyticsError({ cause: "offline" }))
        : Effect.succeed(
            query.includes("analytics.cache_events")
              ? [{ ...row, requests: hits, remoteHits: hits, timeSavedMs: hits * 10 }]
              : [],
          );
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const jobs = yield* AnalyticsRollups;
      const db = yield* Database;
      yield* jobs.hourly;
      yield* jobs.hourly;
      hits = 3;
      yield* jobs.hourly;
      expect(queries).toBe(6);
      const rows = yield* db.query("test.hourly", (q) => q.select().from(schema.usageHourly));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metrics.remoteHits).toBe(3);
      yield* jobs.daily;
      const days = yield* db.query("test.daily", (q) => q.select().from(schema.usageDaily));
      expect(
        days.find((day) => day.day === Math.floor(hour / 86_400_000) * 86_400_000)?.metrics
          .timeSavedMs,
      ).toBe(30);
      fail = true;
      expect((yield* jobs.hourly.pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* db.query("test.unchanged", (q) => q.select().from(schema.usageHourly)))[0]?.metrics
          .remoteHits,
      ).toBe(3);
    }).pipe(
      Effect.provide(
        AnalyticsRollupsLive.pipe(Layer.provide(sql), Layer.provideMerge(DatabaseTest)),
      ),
      Effect.scoped,
    ),
  );
});

test("warehouse templates prune partitions, deduplicate IDs and reject oversized windows", () => {
  const query = rollupSql("cache", hour - 2 * 3_600_000, hour + 3_600_000);
  expect(query).toContain("PARTITION BY event_id");
  expect(query).toContain("day >=");
  expect(query).toContain("ts >=");
  expect(query).toContain("approx_distinct(session_id)");
  expect(query).not.toContain("SELECT *");
  expect(() => rollupSql("artifact", hour - 4 * 3_600_000, hour)).toThrow();
});

test("resumable inventory repairs expired objects and totals only after a complete scan", async () => {
  const inventory = Layer.succeed(AnalyticsInventory, {
    list: (prefix, cursor) =>
      Effect.succeed(
        cursor
          ? { objects: [{ key: `${prefix}bb`, size: 20 }] }
          : { objects: [{ key: `${prefix}aa`, size: 10 }], cursor: "next" },
      ),
  });
  const layer = StorageReconciliationLive.pipe(
    Layer.provideMerge(StorageAccountingLive),
    Layer.provide(inventory),
    Layer.provideMerge(DatabaseTest),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query("test.project", (q) =>
        q
          .insert(schema.project)
          .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
      );
      const accounting = yield* StorageAccounting;
      yield* accounting.record({ orgId: "o", projectId: "p" }, "cc", 100);
      yield* db.query("test.old", (q) => q.update(schema.artifactUsage).set({ observedAt: 0 }));
      const jobs = yield* StorageReconciliation;
      yield* jobs.tick;
      expect(
        (yield* db.query("test.partial", (q) => q.select().from(schema.projectUsage)))[0]
          ?.reconciledAt,
      ).toBeNull();
      yield* jobs.tick;
      const [usage] = yield* db.query("test.complete", (q) => q.select().from(schema.projectUsage));
      expect(usage?.bytes).toBe(30);
      expect(usage?.reconciledAt).toBeGreaterThan(0);
      yield* jobs.tick;
      expect(
        (yield* db.query("test.stable", (q) => q.select().from(schema.projectUsage)))[0]?.bytes,
      ).toBe(30);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
