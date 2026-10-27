/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { AuditLog, AuditLogError } from "@repo/audit";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Effect, Layer } from "effect";
import { auditedAdapter, reconcileAuthAudit } from "./audit-adapter.ts";

const layers = AuditLogTest.pipe(Layer.provideMerge(DatabaseTest));
const user = {
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("Better Auth writes have durable intent, one terminal event, and no credential values", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const audit = yield* AuditLog;
      const raw = drizzleAdapter(database.drizzle, {
        provider: "sqlite",
        schema: { ...schema },
        transaction: false,
      })({});
      const adapter = auditedAdapter(raw, database.drizzle, audit);
      const created = yield* Effect.promise(() =>
        adapter.transaction((transaction) =>
          transaction.create<typeof user, { id: string }>({ model: "user", data: user }),
        ),
      );
      yield* Effect.promise(() =>
        adapter.update({
          model: "user",
          where: [{ field: "id", value: created.id }],
          update: { name: "Grace" },
        }),
      );
      yield* Effect.promise(() =>
        adapter.delete({ model: "user", where: [{ field: "id", value: created.id }] }),
      );
      const rows = yield* database.query("test.audit", (db) => db.select().from(schema.auditEvent));
      expect(rows).toHaveLength(6);
      expect(
        rows.filter((row) => JSON.stringify(row.payload).includes('"status":"committed"')),
      ).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain("ada@example.com");
      expect(JSON.stringify(rows)).not.toContain("Grace");
      expect(
        yield* database.query("test.intents", (db) => db.select().from(schema.authAuditIntent)),
      ).toHaveLength(0);
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));

test("audit failure stops writes; a lost confirmation is reconciled once from actual state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const audit = yield* AuditLog;
      const raw = drizzleAdapter(database.drizzle, {
        provider: "sqlite",
        schema: { ...schema },
        transaction: false,
      })({});
      const broken = {
        ...audit,
        commit: () => Effect.fail(new AuditLogError({ operation: "test", cause: "offline" })),
      };
      yield* Effect.promise(async () => {
        await expect(
          auditedAdapter(raw, database.drizzle, broken).create({ model: "user", data: user }),
        ).rejects.toThrow();
      });
      expect(
        yield* database.query("test.users", (db) => db.select().from(schema.user)),
      ).toHaveLength(0);
      let calls = 0;
      const confirmationFailure = {
        ...audit,
        commit: (...args: Parameters<typeof audit.commit>) =>
          ++calls === 1 ? audit.commit(...args) : broken.commit(),
      };
      yield* Effect.promise(async () => {
        await expect(
          auditedAdapter(raw, database.drizzle, confirmationFailure).create({
            model: "user",
            data: user,
          }),
        ).rejects.toThrow();
      });
      expect(
        yield* database.query("test.users", (db) => db.select().from(schema.user)),
      ).toHaveLength(1);
      expect(
        yield* Effect.promise(() =>
          reconcileAuthAudit(raw, database.drizzle, audit, Date.now() + 600_000),
        ),
      ).toBe(1);
      expect(
        yield* Effect.promise(() =>
          reconcileAuthAudit(raw, database.drizzle, audit, Date.now() + 600_000),
        ),
      ).toBe(0);
      const rows = yield* database.query("test.audit", (db) => db.select().from(schema.auditEvent));
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows[1]?.payload)).toContain('"reconciled":true');
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));

test("failed database mutation resolves to aborted without a committed event", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const audit = yield* AuditLog;
      const raw = drizzleAdapter(database.drizzle, {
        provider: "sqlite",
        schema: { ...schema },
        transaction: false,
      })({});
      const adapter = auditedAdapter(raw, database.drizzle, audit);
      yield* Effect.promise(() => adapter.create({ model: "user", data: user }));
      yield* Effect.promise(async () => {
        await expect(adapter.create({ model: "user", data: user })).rejects.toThrow();
      });
      yield* Effect.promise(() =>
        reconcileAuthAudit(raw, database.drizzle, audit, Date.now() + 600_000),
      );
      const rows = yield* database.query("test.audit", (db) => db.select().from(schema.auditEvent));
      expect(
        rows.filter((row) => JSON.stringify(row.payload).includes('"status":"committed"')),
      ).toHaveLength(1);
      expect(
        rows.filter((row) => JSON.stringify(row.payload).includes('"status":"aborted"')),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));

test("a lost update guard is aborted even if another writer already established the requested state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const audit = yield* AuditLog;
      const raw = drizzleAdapter(database.drizzle, {
        provider: "sqlite",
        schema: { ...schema },
        transaction: false,
      })({});
      const created = yield* Effect.promise(() =>
        raw.create<typeof user, { id: string }>({ model: "user", data: user }),
      );
      // Simulate a guard losing to a writer that installed the identical requested value.
      const guarded = auditedAdapter({ ...raw, update: async () => null }, database.drizzle, audit);
      const result = yield* Effect.promise(() =>
        guarded.update({
          model: "user",
          where: [{ field: "id", value: created.id }],
          update: { name: user.name },
        }),
      );
      expect(result).toBeNull();
      const events = yield* database.query("test.audit", (db) =>
        db.select().from(schema.auditEvent),
      );
      expect(
        events.filter((row) => JSON.stringify(row.payload).includes('"status":"committed"')),
      ).toHaveLength(0);
      expect(
        events.filter((row) => JSON.stringify(row.payload).includes('"status":"aborted"')),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));
