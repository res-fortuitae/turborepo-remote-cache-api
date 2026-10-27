/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs scoped domain effects. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AnalyticsEmitter, ArtifactOpEmitter } from "./emitter.ts";
import {
  AnalyticsEmitterBasin,
  ArtifactOpEmitterBasin,
  AnalyticsSampling,
  CacheEventsStream,
  ArtifactOpsStream,
} from "./stream-emitter.ts";
import {
  ActivityFlags,
  AnalyticsActivity,
  AnalyticsActivityLive,
  StorageAccounting,
  StorageAccountingLive,
} from "./accounting.ts";
import type { ArtifactOperationRecord, CacheEventRecord } from "@repo/api-spec";

const scope = {
  orgId: "org",
  projectId: "project",
  credentialType: "jwt",
  credentialId: "token-id",
  ciProvider: "github",
  repoId: "123",
  ref: "refs/heads/main",
  interactive: false,
} as const;

const event = {
  sessionId: "s",
  source: "REMOTE",
  event: "HIT",
  hash: "abc",
  duration: 42,
} as const;

test("Basin sends one validated batch, preserves LOCAL events, and enriches only approved context", async () => {
  const cache: CacheEventRecord[][] = [];
  const ops: ArtifactOperationRecord[][] = [];

  const bindings = Layer.mergeAll(
    Layer.succeed(AnalyticsSampling, {}),
    Layer.succeed(CacheEventsStream, {
      send: (events) =>
        Effect.sync(() => {
          cache.push([...events]);
        }),
    }),
    Layer.succeed(ArtifactOpsStream, {
      send: (events) =>
        Effect.sync(() => {
          ops.push([...events]);
        }),
    }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* AnalyticsEmitter).emit(scope, [
        event,
        { ...event, source: "LOCAL", duration: -2 },
      ]);
      yield* (yield* ArtifactOpEmitter).emit(scope, {
        method: "POST",
        status: 200,
        clientCi: "bad value with spaces",
        bytes: 0,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AnalyticsEmitterBasin, ArtifactOpEmitterBasin).pipe(Layer.provide(bindings)),
      ),
    ),
  );
  expect(cache).toHaveLength(1);
  expect(cache[0]).toHaveLength(2);
  expect(cache[0]?.[0]).toMatchObject({
    org_id: "org",
    project_id: "project",
    repo_id: "123",
    credential_type: "jwt",
    sample_rate: 1,
    duration_ms: 42,
  });
  expect(cache[0]?.[1]?.duration_ms).toBe(0);
  expect(new Set(cache[0]?.map((row) => row.event_id)).size).toBe(2);
  expect(ops[0]?.[0]).toMatchObject({ op: "query", credential_id: "token-id", client_ci: null });
});

test("stream failures are typed and empty batches do not send", async () => {
  let sends = 0;

  const bindings = Layer.mergeAll(
    Layer.succeed(AnalyticsSampling, { org: 0.5 }),
    Layer.succeed(CacheEventsStream, {
      send: () => {
        sends++;

        return Effect.fail(new Error("offline"));
      },
    }),
  );

  // Use an unsampled tenant to exercise the error deterministically.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* AnalyticsEmitter;
      yield* emitter.emit(scope, []);

      return yield* emitter.emit({ ...scope, orgId: "unsampled" }, [event]).pipe(Effect.result);
    }).pipe(Effect.provide(AnalyticsEmitterBasin.pipe(Layer.provide(bindings)))),
  );

  expect(sends).toBe(1);
  expect(result._tag).toBe("Failure");
});

test("storage totals handle repeats, overwrites, deletes and tenant isolation atomically", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const accounting = yield* StorageAccounting;
      const db = yield* Database;
      yield* accounting.record(scope, "a", 100);
      yield* accounting.record(scope, "a", 100);
      yield* accounting.record(scope, "a", 25);
      yield* accounting.record(scope, "b", 10);
      yield* accounting.record({ ...scope, orgId: "other" }, "a", 200);
      yield* accounting.record(scope, "b", null);
      yield* accounting.record(scope, "b", null);
      const rows = yield* db.query("test.usage", (q) => q.select().from(schema.projectUsage));
      expect(rows.find((row) => row.orgId === "org")?.bytes).toBe(25);
      expect(rows.find((row) => row.orgId === "other")?.bytes).toBe(200);
    }).pipe(
      Effect.provide(StorageAccountingLive.pipe(Layer.provideMerge(DatabaseTest))),
      Effect.scoped,
    ),
  );
});

test("activity flags throttle D1 writes while first hit and last seen persist", async () => {
  const flags = new Map<string, string>();

  const bindings = Layer.succeed(ActivityFlags, {
    get: (key) => Effect.sync(() => flags.get(key) ?? null),
    put: (key, value) =>
      Effect.sync(() => {
        flags.set(key, value);
      }),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query("test.project", (q) =>
        q
          .insert(schema.project)
          .values({ id: "project", orgId: "org", name: "Test", slug: "test", createdAt: 0 }),
      );
      const activity = yield* AnalyticsActivity;
      yield* activity.seen(scope, false);
      yield* activity.seen(scope, true);
      yield* activity.seen(scope, true);
      const rows = yield* db.query("test.signals", (q) => q.select().from(schema.project));
      expect(rows[0]?.firstHitAt).toBeGreaterThan(0);
      expect(rows[0]?.lastSeenAt).toBeGreaterThanOrEqual(rows[0]!.firstHitAt!);
      expect(flags.size).toBe(2);
    }).pipe(
      Effect.provide(
        AnalyticsActivityLive.pipe(Layer.provide(bindings), Layer.provideMerge(DatabaseTest)),
      ),
      Effect.scoped,
    ),
  );
});

test("recording test layers are isolated across builds", async () => {
  const { AnalyticsRecords, AnalyticsEmitterTest } = await import("./testing.ts");
  for (let build = 0; build < 2; build++) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const records = yield* AnalyticsRecords;
        expect(records.cacheEvents).toHaveLength(0);
        yield* (yield* AnalyticsEmitter).emit(scope, [event]);
        expect(records.cacheEvents).toHaveLength(1);
      }).pipe(Effect.provide(AnalyticsEmitterTest)),
    );
  }
});
