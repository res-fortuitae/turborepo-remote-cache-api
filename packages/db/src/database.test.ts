import { describe, expect, test } from "bun:test";
import { Effect, Layer, Result } from "effect";
import { Database, DatabaseError } from "./database.ts";
import {
  GrantRepo,
  GrantRepoLive,
  ProjectRepo,
  ProjectRepoLive,
  TrustPolicyRepo,
  TrustPolicyRepoLive,
} from "./repositories.ts";
import { DatabaseLocalTest } from "./local-d1-test.ts";
import { DatabaseTest } from "./testing.ts";
import { schema } from "./index.ts";
import { checkMigration } from "../scripts/check-migrations.ts";

describe.each([
  ["SQLite", DatabaseTest],
  ["local D1", DatabaseLocalTest],
] as const)("%s", (_name, databaseLayer) => {
  const repos = Layer.mergeAll(ProjectRepoLive, GrantRepoLive, TrustPolicyRepoLive).pipe(
    Layer.provideMerge(databaseLayer),
  );

  const project = { id: "p1", orgId: "org1", slug: "cache", name: "Cache", createdAt: 1 };

  const run = <A, E>(
    program: Effect.Effect<A, E, Database | ProjectRepo | GrantRepo | TrustPolicyRepo>,
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  ) => Effect.runPromise(program.pipe(Effect.provide(repos)));

  describe("database layers", () => {
    test("repositories compose, persist typed rows, and scope lookups", async () => {
      await run(
        Effect.gen(function* () {
          const projects = yield* ProjectRepo;
          const grants = yield* GrantRepo;
          const policies = yield* TrustPolicyRepo;
          yield* projects.create(project);
          expect(yield* projects.find("org1", "p1")).toMatchObject(project);
          expect(yield* projects.find("org2", "p1")).toBeUndefined();
          yield* projects.create({ ...project, id: "p2", orgId: "org2" });
          expect(yield* projects.list("org1")).toHaveLength(1);
          yield* grants.create({
            projectId: "p1",
            principalType: "user",
            principalId: "u1",
            role: "cache:read",
            grantedBy: "admin",
            createdAt: 1,
          });
          expect(yield* grants.list("p1")).toHaveLength(1);
          expect(yield* grants.list("p2")).toEqual([]);
          yield* grants.remove("p1", "user", "u1");
          expect(yield* grants.list("p1")).toEqual([]);

          const policy = {
            id: "t1",
            projectId: "p1",
            provider: "github" as const,
            createdBy: "admin",
            body: {
              issuer: "https://issuer.example",
              claims: { aud: ["cache"] },
              scope: "read" as const,
              ttlSeconds: 60,
            },
          };

          yield* policies.create(policy);
          expect(yield* policies.find("p1", "t1")).toMatchObject({ ...policy, enabled: true });
          expect(yield* policies.find("p2", "t1")).toBeUndefined();
        }),
      );
    });

    test("batch returns ordered results and rolls back the mutation with a failed outbox write", async () => {
      await run(
        Effect.gen(function* () {
          const db = yield* Database;
          const projects = yield* ProjectRepo;

          const rows = yield* db.batch((q) => [
            q.insert(schema.project).values(project).returning(),
            q
              .insert(schema.auditEvent)
              .values({ id: "a1", ts: 1, schemaVersion: 1, payload: { action: "project.created" } })
              .returning(),
          ]);

          expect(rows[0][0]?.id).toBe("p1");
          expect(rows[1][0]?.id).toBe("a1");

          const failed = yield* db
            .batch((q) => [
              q.insert(schema.project).values({ ...project, id: "p2", slug: "second" }),
              q
                .insert(schema.auditEvent)
                .values({ id: "a1", ts: 2, schemaVersion: 1, payload: {} }),
            ])
            .pipe(Effect.result);

          expect(Result.isFailure(failed)).toBe(true);

          if (Result.isFailure(failed)) expect(failed.failure).toBeInstanceOf(DatabaseError);
          expect(yield* projects.find("org1", "p2")).toBeUndefined();
        }),
      );
    });

    test("constraint and synchronous query construction errors are typed failures", async () => {
      await run(
        Effect.gen(function* () {
          const projects = yield* ProjectRepo;
          const db = yield* Database;
          yield* projects.create(project);
          const duplicate = yield* projects.create({ ...project, id: "p2" }).pipe(Effect.result);
          expect(Result.isFailure(duplicate)).toBe(true);

          if (Result.isFailure(duplicate))
            expect(duplicate.failure.operation).toBe("ProjectRepo.create");

          const sync = yield* db
            .query("broken", () => {
              throw new Error("construction failure");
            })
            .pipe(Effect.result);

          expect(Result.isFailure(sync)).toBe(true);
        }),
      );
    });

    test("each layer build has a fresh database", async () => {
      await run(
        Effect.gen(function* () {
          yield* (yield* ProjectRepo).create(project);
        }),
      );
      expect(
        await run(
          Effect.gen(function* () {
            return yield* (yield* ProjectRepo).list("org1");
          }),
        ),
      ).toEqual([]);
    });
  });
});

describe("additive migration gate", () => {
  test("accepts new tables, indexes, and columns", () => {
    expect(
      checkMigration(
        "CREATE TABLE t (id text); CREATE UNIQUE INDEX i ON t(id); ALTER TABLE t ADD COLUMN name text;",
      ),
    ).toEqual([]);
  });
  test("rejects destructive and data-changing SQL", () => {
    for (const sql of [
      "DROP TABLE t",
      "ALTER TABLE t DROP COLUMN id",
      "ALTER TABLE t RENAME TO old",
      "DELETE FROM t",
      "UPDATE t SET id = 'x'",
      "PRAGMA foreign_keys = OFF",
    ])
      expect(checkMigration(sql)).toEqual([sql]);
  });
});
