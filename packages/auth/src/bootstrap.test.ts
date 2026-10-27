/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary over real atomic D1 batches. */
import { expect, test } from "bun:test";
import { AuditLog } from "@repo/audit";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { bootstrapOwner } from "./bootstrap.ts";

const layer = AuditLogTest.pipe(Layer.provideMerge(DatabaseTest));
const seed = Effect.gen(function* () {
  const database = yield* Database;
  const now = new Date();
  yield* database.query("test.seed", (db) =>
    db.insert(schema.user).values(
      ["first", "second"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        role: "member",
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );
  return database;
});

test("conditional owner bootstrap and its audit commit together and preserve the first owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* seed;
      const audit = yield* AuditLog;
      yield* bootstrapOwner(audit, "first");
      yield* bootstrapOwner(audit, "second");
      const users = yield* database.query("test.users", (db) => db.select().from(schema.user));
      expect(users.filter((user) => user.role === "owner").map((user) => user.id)).toEqual([
        "first",
      ]);
      const events = yield* database.query("test.audit", (db) =>
        db.select().from(schema.auditEvent),
      );
      expect(events.map((row) => row.payload.action)).toEqual([
        "instance.owner.bootstrap.checked",
        "instance.owner.bootstrap.checked",
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  ));

test("a real audit insert failure prevents the ownership change", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* seed;
      const audit = yield* AuditLog;
      yield* database.query("test.failAudit", (db) =>
        db.run(
          sql`CREATE TRIGGER fail_bootstrap_audit BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
        ),
      );
      expect((yield* Effect.result(bootstrapOwner(audit, "first")))._tag).toBe("Failure");
      const users = yield* database.query("test.users", (db) => db.select().from(schema.user));
      expect(users.every((user) => user.role === "member")).toBe(true);
      expect(
        yield* database.query("test.audit", (db) => db.select().from(schema.auditEvent)),
      ).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  ));
