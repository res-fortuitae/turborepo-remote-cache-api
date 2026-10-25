/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes effects at the test boundary. */
import { expect, test } from "bun:test";
import { AuditLogD1Only } from "@repo/audit";
import { Authorization, AuthorizationDatabaseLive } from "@repo/authz";
import { Database, InstanceSettingsRepoLive, deleteOrganizationProjects, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { eq } from "drizzle-orm";
import { Effect, Layer, Result } from "effect";
import { ProjectLimits } from "./projects.ts";
import { ProjectMaintenance, ProjectMaintenanceLive, ProjectStorage } from "./maintenance.ts";

const limits = Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100 });
const seed = Effect.gen(function* () {
  const database = yield* Database;
  yield* database.batch((db) => [
    db
      .insert(schema.organization)
      .values({ id: "org", name: "Org", slug: "org", createdAt: new Date(0) }),
    db.insert(schema.project).values([
      { id: "a", orgId: "org", name: "A", slug: "a", retentionDays: 1, createdAt: 0 },
      { id: "b", orgId: "org", name: "B", slug: "b", retentionDays: 30, createdAt: 0 },
    ]),
    db.insert(schema.trustPolicy).values({
      id: "trust",
      projectId: "a",
      provider: "github",
      createdBy: "u",
      body: { issuer: "https://example.com", claims: {}, scope: "read", ttlSeconds: 10 },
    }),
  ]);
});

const fixture = (storage: typeof ProjectStorage.Service) =>
  Layer.mergeAll(
    ProjectMaintenanceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          AuditLogD1Only,
          InstanceSettingsRepoLive,
          limits,
          Layer.succeed(ProjectStorage, storage),
        ),
      ),
    ),
    AuthorizationDatabaseLive,
  ).pipe(Layer.provideMerge(DatabaseTest));

test("organization deletion persists intents, disables trust and resumes bounded cleanup after failure", () => {
  const keys = new Map(Array.from({ length: 1003 }, (_, i) => [`org/a/${i}`, new Date(0)]));
  keys.set("org/b/same-hash", new Date(0));
  let fail = true;
  const revoked: string[] = [];
  const storage: typeof ProjectStorage.Service = {
    list: (prefix) =>
      Effect.succeed({
        objects: [...keys]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, 1000)
          .map(([key, uploaded]) => ({ key, uploaded })),
      }),
    delete: (batch) =>
      Effect.sync(() => {
        expect(batch.length).toBeLessThanOrEqual(1000);
        if (fail) {
          fail = false;
          throw new Error("R2 unavailable");
        }
        for (const key of batch) keys.delete(key);
      }).pipe(Effect.catchDefect((cause) => Effect.fail(cause))),
    revoke: (id) =>
      Effect.sync(() => {
        revoked.push(id);
      }),
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const database = yield* Database;
      // Org teardown uses the same durable intents and survives removal of the parent.
      yield* database.batch((db) => [
        ...deleteOrganizationProjects(db, "org", 1),
        db.delete(schema.organization).where(eq(schema.organization.id, "org")),
      ]);
      const authorization = yield* Authorization;
      expect(
        (yield* authorization.can(
          {
            kind: "cacheJwt",
            id: "token",
            orgId: "org",
            projectId: "a",
            scope: "read write",
            issuedAt: 1,
            expiresAt: 9999999999,
          },
          "cache:read",
          { orgId: "org", projectId: "a" },
        )).allowed,
      ).toBe(false);
      const [trust] = yield* database.query("test.trust", (db) =>
        db.select().from(schema.trustPolicy),
      );
      expect(trust?.enabled).toBe(false);
      const maintenance = yield* ProjectMaintenance;
      expect(Result.isFailure(yield* Effect.result(maintenance.tick))).toBe(true);
      expect(keys.size).toBe(1004);
      yield* maintenance.tick;
      expect(keys.size).toBe(4);
      yield* maintenance.tick;
      expect(keys.has("org/b/same-hash")).toBe(true);
      yield* maintenance.tick;
      const [job] = yield* database.query("test.job", (db) =>
        db.select().from(schema.projectDeletion).where(eq(schema.projectDeletion.projectId, "a")),
      );
      expect(job?.completedAt).not.toBeNull();
      expect(revoked).toEqual(["a", "a", "a", "a"]);
      const remaining = yield* database.query("test.projects", (db) =>
        db.select().from(schema.project),
      );
      expect(remaining.map((project) => project.id)).toEqual(["b"]);
    }).pipe(Effect.provide(fixture(storage))),
  );
});

test("retention clamps days, resumes listing cursors and preserves newer artifacts and other prefixes", () => {
  const old = new Date(0);
  const fresh = new Date("2099-01-01");
  const removed: string[] = [];
  const requests: (string | undefined)[] = [];
  const storage: typeof ProjectStorage.Service = {
    list: (prefix, cursor) =>
      Effect.sync(() => {
        requests.push(cursor);
        return prefix === "org/a/"
          ? {
              objects: [{ key: `${prefix}${cursor ?? "first"}`, uploaded: cursor ? fresh : old }],
              cursor: cursor ? undefined : "next",
            }
          : { objects: [] };
      }),
    delete: (keys) =>
      Effect.sync(() => {
        removed.push(...keys);
      }),
    revoke: () => Effect.void,
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const database = yield* Database;
      yield* database.query("test.onlyA", (db) =>
        db.delete(schema.project).where(eq(schema.project.id, "b")),
      );
      const maintenance = yield* ProjectMaintenance;
      yield* maintenance.tick;
      yield* maintenance.tick;
      expect(removed).toEqual(["org/a/first"]);
      expect(requests).toEqual([undefined, "next"]);
      const [state] = yield* database.query("test.cursor", (db) =>
        db.select().from(schema.projectRetention),
      );
      expect(state?.cursor).toBeNull();
    }).pipe(Effect.provide(fixture(storage))),
  );
});
