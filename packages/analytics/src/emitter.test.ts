/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs scoped SQLite-backed domain effects. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AnalyticsEmitter, AnalyticsEmitterLite, AnalyticsEmitterDisabled } from "./emitter.ts";

const event = {
  sessionId: "s",
  source: "REMOTE",
  event: "HIT",
  hash: "abc",
  duration: 42,
} as const;

const layer = AnalyticsEmitterLite.pipe(Layer.provideMerge(DatabaseTest));

test("lite counters batch and add atomically, isolate projects and ignore local hits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* AnalyticsEmitter;
      const db = yield* Database;
      yield* emitter.emit({ orgId: "org", projectId: "a" }, [
        event,
        event,
        { ...event, event: "MISS" },
        { ...event, source: "LOCAL" },
      ]);
      yield* emitter.emit({ orgId: "org", projectId: "a" }, [event]);
      yield* emitter.emit({ orgId: "org", projectId: "b" }, [{ ...event, event: "MISS" }]);
      yield* emitter.emit({ orgId: "other", projectId: "a" }, [event]);
      const rows = yield* db.query("test.rollups", (db) => db.select().from(schema.rollup));
      const projectA = rows.filter((row) => row.orgId === "org" && row.projectId === "a");
      expect(Object.fromEntries(projectA.map((row) => [row.metric, row.value]))).toEqual({
        requests: 4,
        remoteHits: 3,
        remoteMisses: 1,
        timeSavedMs: 126,
      });
      expect(projectA.every((row) => row.bucketStart % 3_600_000 === 0)).toBe(true);
      expect(rows.filter((row) => row.projectId === "b").map((row) => row.value)).toEqual([1, 1]);
      expect(rows.filter((row) => row.orgId === "other").map((row) => row.value)).toEqual([
        1, 1, 42,
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

test("disabled analytics needs no database and lite empty batches write nothing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* AnalyticsEmitter;
      yield* emitter.emit({ orgId: "org", projectId: "a" }, [event]);
    }).pipe(Effect.provide(AnalyticsEmitterDisabled)),
  );

  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* AnalyticsEmitter;
      const db = yield* Database;
      yield* emitter.emit({ orgId: "org", projectId: "a" }, []);

      return yield* db.query("test.empty", (db) => db.select().from(schema.rollup));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  expect(rows).toEqual([]);
});

test("upload operation persistence retains provenance, ignores reads and failed writes", async () => {
  const { ArtifactOpEmitter, ArtifactOpEmitterD1Uploads } = await import("./emitter.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* ArtifactOpEmitter;
      const db = yield* Database;
      const scope = { orgId: "o", projectId: "p" };
      const provenance = {
        credentialType: "apiKey",
        credentialId: "key",
        uploadedAt: "2026-10-25T12:00:00Z",
      };
      yield* emitter.emit(scope, { method: "PUT", status: 202, hash: "abc", provenance });
      yield* emitter.emit(scope, { method: "PUT", status: 413, hash: "abc", provenance });
      yield* emitter.emit(scope, { method: "GET", status: 200, hash: "abc" });
      const rows = yield* db.query("test.uploads", (q) =>
        q.select().from(schema.artifactOperation),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...scope, hash: "abc", provenance });
    }).pipe(
      Effect.provide(ArtifactOpEmitterD1Uploads.pipe(Layer.provideMerge(DatabaseTest))),
      Effect.scoped,
    ),
  );
});
