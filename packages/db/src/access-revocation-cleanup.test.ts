/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Offline SQL is exercised against a disposable database. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { sql } from "drizzle-orm";
import { Database } from "./database.ts";
import * as schema from "./schema/index.ts";
import { DatabaseTest } from "./testing.ts";

test("offline cleanup removes orphan grants, preserves current grants, and invalidates old sessions", async () => {
  const cleanup = await Bun.file(
    new URL("../scripts/access-revocation-cleanup.sql", import.meta.url),
  ).text();
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const now = new Date();
      yield* database.batch((db) => [
        db.insert(schema.user).values({
          id: "u",
          name: "User",
          email: "u@example.com",
          createdAt: now,
          updatedAt: now,
        }),
        db
          .insert(schema.organization)
          .values({ id: "o", name: "Org", slug: "org", createdAt: now }),
        db
          .insert(schema.member)
          .values({ id: "m", organizationId: "o", userId: "u", role: "member", createdAt: now }),
        db.insert(schema.session).values({
          id: "s",
          userId: "u",
          token: "old-device-or-browser",
          createdAt: now,
          updatedAt: now,
          expiresAt: now,
        }),
        db
          .insert(schema.project)
          .values({ id: "p", orgId: "o", name: "Project", slug: "project", createdAt: 1 }),
        db.insert(schema.projectGrant).values([
          {
            projectId: "p",
            principalType: "user",
            principalId: "u",
            role: "cache:read",
            grantedBy: "u",
            createdAt: 1,
          },
          {
            projectId: "p",
            principalType: "user",
            principalId: "departed",
            role: "project:admin",
            grantedBy: "u",
            createdAt: 1,
          },
          {
            projectId: "p",
            principalType: "team",
            principalId: "deleted-team",
            role: "cache:write",
            grantedBy: "u",
            createdAt: 1,
          },
        ]),
      ]);
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const statement of cleanup
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)) {
          yield* database.query("test.offlineCleanup", (db) => db.run(sql.raw(statement)));
        }
        expect(
          yield* database.query("test.sessions", (db) => db.select().from(schema.session)),
        ).toEqual([]);
        expect(
          yield* database.query("test.grants", (db) => db.select().from(schema.projectGrant)),
        ).toMatchObject([{ principalId: "u" }]);
        expect(
          (yield* database.query("test.grants", (db) => db.select().from(schema.projectGrant)))
            .length,
        ).toBe(1);
      }
    }).pipe(Effect.provide(DatabaseTest)),
  );
});
