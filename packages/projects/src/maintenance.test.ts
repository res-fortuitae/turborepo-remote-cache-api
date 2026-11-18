/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes effects at the test boundary. */
import { expect, test } from "bun:test";
import { AuditLogD1Only } from "@repo/audit";
import { Authorization, AuthorizationDatabaseLive } from "@repo/authz";
import { Database, InstanceSettingsRepoLive, deleteOrganizationProjects, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Result } from "effect";
import { ProjectLimits } from "./projects.ts";
import { ProjectMaintenance, ProjectMaintenanceLive, ProjectStorage } from "./maintenance.ts";

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

const fixture = (storage: typeof ProjectStorage.Service, maintenanceRetentionDays?: number) =>
  Layer.mergeAll(
    ProjectMaintenanceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          AuditLogD1Only,
          InstanceSettingsRepoLive,
          Layer.succeed(ProjectLimits, {
            retentionDays: 30,
            maxArtifactBytes: 100,
            maintenanceRetentionDays,
          }),
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
    invalidateCache: () => Effect.void,
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
      yield* maintenance.tick;
      expect(keys.size).toBe(1004);
      yield* database.query("test.retryNow", (db) =>
        db.update(schema.projectDeletion).set({ nextAttemptAt: 0 }),
      );
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
  const invalidated: string[] = [];
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
    invalidateCache: (id) =>
      Effect.sync(() => {
        invalidated.push(id);
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
      expect(invalidated).toEqual(["a", "a"]);
      expect(requests).toEqual([undefined, "next"]);
      const [state] = yield* database.query("test.cursor", (db) =>
        db.select().from(schema.projectRetention),
      );
      expect(state?.cursor).toBeNull();
    }).pipe(Effect.provide(fixture(storage))),
  );
});

test("retention retries failed invalidation after deletion without advancing the cursor", () => {
  let present = true;
  let generation = 0;
  let failInvalidation = true;
  const storage: typeof ProjectStorage.Service = {
    list: () =>
      Effect.succeed({ objects: present ? [{ key: "org/a/abc", uploaded: new Date(0) }] : [] }),
    delete: () =>
      Effect.sync(() => {
        present = false;
      }),
    revoke: () => Effect.void,
    invalidateCache: () =>
      Effect.gen(function* () {
        if (failInvalidation) {
          failInvalidation = false;
          return yield* Effect.fail(new Error("Coordinator unavailable"));
        }
        generation++;
      }),
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const database = yield* Database;
      yield* database.query("test.onlyA", (db) =>
        db.delete(schema.project).where(eq(schema.project.id, "b")),
      );
      const maintenance = yield* ProjectMaintenance;
      expect(Result.isFailure(yield* Effect.result(maintenance.tick))).toBe(true);
      expect(present).toBe(false);
      expect(
        (yield* database.query("test.cursor", (db) => db.select().from(schema.projectRetention)))
          .length,
      ).toBe(0);
      yield* maintenance.tick;
      expect(generation).toBe(1);
    }).pipe(Effect.provide(fixture(storage))),
  );
});

test("poisoned deletion backs off while another deletion and retention progress", () => {
  const listed: string[] = [];
  const storage: typeof ProjectStorage.Service = {
    list: (prefix) => {
      listed.push(prefix);
      return prefix === "org/a/"
        ? Effect.fail(new Error("poison"))
        : Effect.succeed({ objects: [] });
    },
    delete: () => Effect.void,
    revoke: () => Effect.void,
    invalidateCache: () => Effect.void,
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const database = yield* Database;
      yield* database.query("test.jobs", (db) =>
        db.insert(schema.projectDeletion).values({ projectId: "a", orgId: "org", requestedAt: 0 }),
      );
      const maintenance = yield* ProjectMaintenance;
      yield* maintenance.tick;
      expect(listed).toEqual(["org/a/", "org/b/"]);
      yield* database.query("test.jobs", (db) =>
        db.insert(schema.projectDeletion).values({ projectId: "b", orgId: "org", requestedAt: 1 }),
      );
      yield* maintenance.tick;
      const jobs = yield* database.query("test.jobs", (db) =>
        db.select().from(schema.projectDeletion),
      );
      expect(jobs.find((job) => job.projectId === "b")?.completedAt).not.toBeNull();
      expect(jobs.find((job) => job.projectId === "a")?.attempts).toBe(1);
    }).pipe(Effect.provide(fixture(storage))),
  );
});

test("deletion removes every project table except durable tombstones and audit history", () => {
  const storage: typeof ProjectStorage.Service = {
    list: () => Effect.succeed({ objects: [] }),
    delete: () => Effect.void,
    revoke: () => Effect.void,
    invalidateCache: () => Effect.void,
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const database = yield* Database;
      const common = { projectId: "a", orgId: "org" };
      yield* database.batch((db) => [
        db.insert(schema.projectDeletion).values({ ...common, requestedAt: 0 }),
        db.insert(schema.projectUsage).values({ ...common, bytes: 42 }),
        db.insert(schema.artifactUsage).values({ ...common, hash: "h", bytes: 42 }),
        db
          .insert(schema.usageHourly)
          .values({ ...common, hour: 0, source: "test", dimension: "all", metrics: {} }),
        db.insert(schema.usageDaily).values({ ...common, day: 0, dimension: "all", metrics: {} }),
        db.insert(schema.usageInventory).values({ ...common, startedAt: 0 }),
        db
          .insert(schema.artifactOperation)
          .values({ ...common, id: "op", hash: "h", createdAt: 0, provenance: {} }),
        db
          .insert(schema.anomalyIncident)
          .values({ ...common, id: "incident", code: "test", detail: "test", createdAt: 0 }),
        db
          .insert(schema.artifactPurgeJob)
          .values({ projectId: "a", id: "purge", state: "pending", data: "{}" }),
        db
          .insert(schema.cacheApiKey)
          .values({ ...common, id: "key", orgEpoch: 0, projectEpoch: 0 }),
        db.insert(schema.apikey).values({
          id: "key",
          referenceId: "org",
          key: "private",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      ]);
      yield* (yield* ProjectMaintenance).tick;
      const tables = yield* database.query("test.tables", (db) =>
        db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`),
      );
      for (const { name } of tables) {
        if (["audit_event", "project_deletion"].includes(name)) continue;
        const columns = yield* database.query("test.columns", (db) =>
          db.all<{ name: string }>(sql.raw(`pragma table_info("${name}")`)),
        );
        if (!columns.some((column) => column.name === "project_id")) continue;
        const rows = yield* database.query("test.orphans", (db) =>
          db.all(sql`select * from ${sql.identifier(name)} where project_id = ${"a"}`),
        );
        expect(rows).toEqual([]);
      }
      expect(yield* database.query("test.keys", (db) => db.select().from(schema.apikey))).toEqual(
        [],
      );
    }).pipe(Effect.provide(fixture(storage))),
  );
});

test("maintenance prunes old notifications and operations in bounded batches without projects", () => {
  const storage: typeof ProjectStorage.Service = {
    list: () => Effect.die("No projects to list"),
    delete: () => Effect.die("No artifacts to delete"),
    invalidateCache: () => Effect.void,
    revoke: () => Effect.void,
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const now = Date.now();
      const day = 86_400_000;
      const records = [
        ...Array.from({ length: 501 }, (_, i) => ({
          id: `old-${i}`,
          createdAt: now - 8 * day - (501 - i),
        })),
        { id: "recent", createdAt: now - 6 * day },
      ];
      for (let offset = 0; offset < records.length; offset += 10) {
        const batch = records.slice(offset, offset + 10);
        yield* database.batch((db) => [
          db
            .insert(schema.notification)
            .values(batch.map((row) => ({ ...row, userId: "user", kind: "quota", detail: "{}" }))),
          db.insert(schema.artifactOperation).values(
            batch.map((row) => ({
              ...row,
              orgId: "org",
              projectId: "project",
              hash: "hash",
              provenance: {},
            })),
          ),
        ]);
      }
      const maintenance = yield* ProjectMaintenance;
      const remaining = Effect.forEach([schema.notification, schema.artifactOperation], (table) =>
        database.query("test.remaining", (db) =>
          db.select({ id: table.id }).from(table).orderBy(table.id),
        ),
      );
      yield* maintenance.tick;
      expect(yield* remaining).toEqual(
        Array.from({ length: 2 }, () => [{ id: "old-500" }, { id: "recent" }]),
      );
      yield* maintenance.tick;
      expect(yield* remaining).toEqual([[{ id: "recent" }], [{ id: "recent" }]]);
    }).pipe(Effect.provide(fixture(storage, 7))),
  );
});
