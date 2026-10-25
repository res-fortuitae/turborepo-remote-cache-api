import { describe, expect, test } from "bun:test";
import { AuditEvent } from "@repo/api-spec";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  AUDIT_RETENTION_MILLIS,
  type AuditInput,
  AuditLog,
  AuditLogLive,
  AuditLogD1Only,
  AuditSinkMemory,
  AuditSinkUnconfigured,
  canonicalJson,
  hashEvent,
} from "./audit-log.ts";
import { AuditLogTest } from "./testing.ts";

const isAuditEvent = Schema.is(AuditEvent);

const input = (action: string): AuditInput => ({
  scope: "org",
  orgId: "org_1",
  actor: { type: "user", id: "user_1", display: "Ada" },
  action,
  target: { type: "member", id: "user_2" },
  outcome: "allow",
  ip: "203.0.113.7",
  userAgent: "test",
  requestId: "req_1",
  metadata: { role: "admin" },
});

const run = <A, E>(
  program: Effect.Effect<A, E, AuditLog | AuditSinkMemory | Database | TestClock.TestClock>,
) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(AuditLogTest, TestClock.layer()).pipe(Layer.provideMerge(DatabaseTest)),
      ),
    ),
  );

const countRows = Effect.flatMap(Database, (database) =>
  database
    .query("count", (db) => db.select().from(schema.auditEvent))
    .pipe(Effect.map((rows) => rows.length)),
);

describe("AuditLog.record", () => {
  test("builds a valid, hashed event", async () => {
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 24));
        const { event } = yield* (yield* AuditLog).record(input("member.role.updated"));

        expect(isAuditEvent(event)).toBe(true);
        expect(event.ts).toBe("2026-10-24T00:00:00.000Z");
        expect(event.prevHash).toBeNull();
        const { hash, ...unhashed } = event;
        expect(hash).toBe(yield* hashEvent(unhashed));
      }),
    );
  });

  test("commits with the change in one batch", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const { statement } = yield* (yield* AuditLog).record(input("project.created"));

        yield* database.batch((db) => [
          db
            .insert(schema.project)
            .values({ id: "p1", orgId: "org_1", slug: "web", name: "Web", createdAt: 0 }),
          statement(db),
        ]);

        expect(yield* countRows).toBe(1);
      }),
    );
  });

  test("is rolled back when the change fails", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const { statement } = yield* (yield* AuditLog).record(input("project.created"));

        const result = yield* Effect.result(
          database.batch((db) => [
            statement(db),
            db.run(sql`insert into missing_table values (1)`),
          ]),
        );

        expect(result._tag).toBe("Failure");
        expect(yield* countRows).toBe(0);
      }),
    );
  });
});

describe("outbox", () => {
  test("drains rows in order once, then marks them exported", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const audit = yield* AuditLog;

        for (const action of ["a.one", "a.two", "a.three"]) {
          const { statement } = yield* audit.record(input(action));
          yield* database.batch((db) => [statement(db)]);
          yield* TestClock.adjust(1);
        }

        expect(yield* audit.drainOutbox(2)).toBe(2);
        expect(yield* audit.drainOutbox(2)).toBe(1);
        expect(yield* audit.drainOutbox(2)).toBe(0);
        const sent = yield* (yield* AuditSinkMemory).events;
        expect(sent.map((event) => event.action)).toEqual(["a.one", "a.two", "a.three"]);
      }),
    );
  });

  test("leaves rows unexported when the sink fails", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const audit = yield* AuditLog;
        const { statement } = yield* audit.record(input("a.one"));
        yield* database.batch((db) => [statement(db)]);

        const result = yield* Effect.result(audit.drainOutbox());
        expect(result._tag).toBe("Failure");
        const rows = yield* database.query("rows", (db) => db.select().from(schema.auditEvent));
        expect(rows.map((row) => row.exportedAt)).toEqual([null]);
      }).pipe(
        Effect.provide(
          AuditLogLive.pipe(Layer.provide(AuditSinkUnconfigured), Layer.provideMerge(DatabaseTest)),
        ),
      ),
    );
  });

  test("prune deletes only exported rows past retention", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const audit = yield* AuditLog;

        for (const action of ["old.exported", "old.pending"]) {
          const { statement } = yield* audit.record(input(action));
          yield* database.batch((db) => [statement(db)]);

          if (action === "old.exported") yield* audit.drainOutbox();
        }

        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);
        const { statement } = yield* audit.record(input("new"));
        yield* database.batch((db) => [statement(db)]);

        expect(yield* audit.prune()).toBe(1);
        expect(yield* countRows).toBe(2);
      }),
    );
  });

  test("recordStandalone sends without a row", async () => {
    await run(
      Effect.gen(function* () {
        yield* (yield* AuditLog).recordStandalone({
          ...input("oidc.exchange.denied"),
          outcome: "deny",
        });

        expect((yield* (yield* AuditSinkMemory).events).length).toBe(1);
        expect(yield* countRows).toBe(0);
      }),
    );
  });
});

test("canonicalJson ignores key order", () => {
  const event = input("a.one");

  expect(canonicalJson({ metadata: { b: 1, a: [2] }, action: event.action })).toBe(
    canonicalJson({ action: event.action, metadata: { a: [2], b: 1 } }),
  );
});

test("D1-only fallback persists standalone denials in the hash chain and never prunes unexported rows", async () => {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercises the fallback layer over the scoped SQLite adapter at the Bun boundary.
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const database = yield* Database;
      const denied = { ...input("cache.denied"), outcome: "deny" as const };
      const first = yield* audit.recordStandalone(denied);
      const second = yield* audit.recordStandalone(denied);
      const rows = yield* database.query("test.denials", (db) =>
        db.select().from(schema.auditEvent),
      );
      expect(rows.length).toBe(2);
      expect(rows[0]?.exportedAt).toBeNull();
      expect(rows[1]?.payload.prevHash).toBe(first.hash);
      expect(rows[1]?.hash).toBe(second.hash);
      expect(rows[1]?.sequence).toBe(2);
      expect(yield* audit.prune(-1)).toBe(0);
      expect(yield* countRows).toBe(2);
    }).pipe(Effect.provide(AuditLogD1Only.pipe(Layer.provideMerge(DatabaseTest))), Effect.scoped),
  );
});
