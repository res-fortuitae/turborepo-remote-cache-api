import { QuotasTest, QuotaEvictionTest } from "./testing.ts";
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs real migrated SQLite quota transactions. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";

import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { Quotas, QuotaEviction } from "./quotas.ts";
import { PurgeInventory, type PurgeObject } from "./incident.ts";
import { ArtifactPurger } from "./purge.ts";
const scope = { orgId: "o", projectId: "p" };
const event = {
  scope: "org" as const,
  ...scope,
  actor: { type: "user" as const, id: "u", display: "User" },
  action: "test",
  target: { type: "project", id: "p" },
  outcome: "allow" as const,
  ip: "",
  userAgent: "",
  requestId: "r",
  metadata: {},
};
const layer = QuotasTest;
const seed = Effect.gen(function* () {
  const db = yield* Database;
  yield* db.batch((q) => [
    q
      .insert(schema.organization)
      .values({ id: "o", slug: "org", name: "Org", createdAt: new Date() }),
    q.insert(schema.project).values([
      { id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 },
      { id: "q", orgId: "o", slug: "q", name: "Q", createdAt: 0 },
    ]),
  ]);
});

test("concurrent uploads reserve shared org capacity atomically and release without double-counting", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const quota = yield* Quotas;
      const attempts = yield* Effect.all(
        [
          quota.reserve(scope, "aa", 60).pipe(Effect.result),
          quota.reserve({ ...scope, projectId: "q" }, "bb", 60).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1);
      const accepted = attempts.find((result) => result._tag === "Success");
      if (!accepted || accepted._tag !== "Success") throw new Error("No reservation");
      yield* quota.finish(accepted.success, 60);
      expect((yield* quota.status(scope)).org.usage.storageBytes).toBe(60);
      expect((yield* quota.status(scope)).org.usage.reservedBytes).toBe(0);
      const db = yield* Database;
      const rows = yield* db.query("test.ledger", (q) => q.select().from(schema.artifactUsage));
      const row = rows[0]!;
      const replacement = yield* quota.reserve(
        { orgId: row.orgId, projectId: row.projectId },
        row.hash,
        70,
      );
      yield* quota.finish(replacement, 70);
      expect((yield* quota.status(scope)).org.usage.storageBytes).toBe(70);
    }).pipe(Effect.provide(layer)),
  );
});

test("daily bandwidth/request quotas pause writes, notify thresholds once and preserve readable status", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const quota = yield* Quotas,
        db = yield* Database;
      yield* quota.configure(
        scope,
        { storageBytes: 100, bandwidthBytes: 100, requests: 1, onQuotaExceeded: "reject" },
        event,
      );
      const id = yield* quota.reserve(scope, "aa", 85);
      yield* quota.finish(id, 85);
      expect((yield* quota.status(scope)).overLimit).toBe(true);
      expect((yield* Effect.result(quota.reserve(scope, "bb", 1)))._tag).toBe("Failure");
      yield* db.batch((q) => [
        q.insert(schema.user).values({
          id: "u",
          name: "U",
          email: "u@example.test",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        q.insert(schema.member).values({
          id: "m",
          userId: "u",
          organizationId: "o",
          role: "owner",
          createdAt: new Date(),
        }),
      ]);
      yield* quota.notify(scope);
      yield* quota.notify(scope);
      const alerts = yield* db.query("test.alerts", (q) => q.select().from(schema.notification));
      expect(alerts.some((alert) => alert.detail.includes("80%"))).toBe(true);
      expect(new Set(alerts.map((alert) => alert.id)).size).toBe(alerts.length);
    }).pipe(Effect.provide(layer)),
  );
});

test("eviction scans all pages before deleting the oldest provenance and commits one summary", async () => {
  const objects = new Map<string, PurgeObject>([
    [
      "o/p/aa",
      {
        key: "o/p/aa",
        etag: "new",
        size: 70,
        uploaded: 3,
        metadata: { uploadedAt: "2026-10-27T00:00:00Z" },
      },
    ],
    [
      "o/p/bb",
      {
        key: "o/p/bb",
        etag: "old",
        size: 30,
        uploaded: 1,
        metadata: { uploadedAt: "2026-10-20T00:00:00Z" },
      },
    ],
  ]);
  const inventory = Layer.effect(
    PurgeInventory,
    Effect.gen(function* () {
      const db = yield* Database;
      return {
        list: (_prefix: string, cursor?: string) =>
          Effect.succeed(
            cursor
              ? { objects: objects.has("o/p/bb") ? [objects.get("o/p/bb")!] : [] }
              : {
                  objects: objects.has("o/p/aa") ? [objects.get("o/p/aa")!] : [],
                  cursor: "second",
                },
          ),
        head: (key: string) => Effect.succeed(objects.get(key) ?? null),
        remove: (keys: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            for (const key of keys) {
              const object = objects.get(key);
              if (!object) continue;
              objects.delete(key);
              yield* db.query("test.remove", (q) =>
                q
                  .update(schema.projectUsage)
                  .set({ bytes: 70 })
                  .where(eq(schema.projectUsage.projectId, "p")),
              );
            }
          }).pipe(Effect.orDie),
      };
    }),
  );
  const eviction = QuotaEvictionTest.pipe(
    Layer.provide(inventory),
    Layer.provide(
      Layer.succeed(ArtifactPurger, {
        invalidate: () => Effect.succeed(1),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const quota = yield* Quotas,
        db = yield* Database,
        job = yield* QuotaEviction;
      yield* db.query("test.full", (q) =>
        q.insert(schema.projectUsage).values({ ...scope, bytes: 100 }),
      );
      yield* quota.configure(
        scope,
        {
          storageBytes: 100,
          bandwidthBytes: null,
          requests: null,
          onQuotaExceeded: "evict-oldest",
        },
        event,
      );
      expect((yield* Effect.result(quota.reserve(scope, "cc", 1)))._tag).toBe("Failure");
      yield* job.tick;
      expect(objects.size).toBe(2);
      yield* job.tick;
      expect(objects.size).toBe(2);
      yield* job.tick;
      expect(objects.has("o/p/aa")).toBe(true);
      expect(objects.has("o/p/bb")).toBe(false);
      yield* job.tick;
      expect((yield* quota.status(scope)).eviction?.state).toBe("complete");
      const events = yield* db.query("test.audit", (q) => q.select().from(schema.auditEvent));
      expect(events.filter((row) => row.payload.action === "quota.eviction.complete")).toHaveLength(
        1,
      );
      const metrics = yield* db.query("test.metrics", (q) => q.select().from(schema.rollup));
      expect(metrics.find((row) => row.metric === "evictions")?.value).toBe(1);
    }).pipe(Effect.provide(eviction)),
  );
});
