import { describe, expect, test } from "bun:test";
import { Database, type DatabaseService, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { AUDIT_RETENTION_MILLIS, type AuditInput, AuditLog, AuditSinkMemory } from "./audit-log.ts";
import { dailyAuditJob, drainOutboxJob } from "./jobs.ts";
import {
  AuditIntegrity,
  AuditIntegrityLive,
  type CheckpointBucket,
  CheckpointStoreTest,
  CheckpointStore,
  CheckpointStoreError,
  makeCheckpointStore,
} from "./integrity.ts";
import { AuditLogTest } from "./testing.ts";

const input = (action: string, orgId = "org_1"): AuditInput => ({
  scope: "org",
  orgId,
  actor: { type: "user", id: "user_1", display: "Ada" },
  action,
  target: { type: "member", id: "user_2" },
  outcome: "allow",
  ip: "203.0.113.7",
  userAgent: "test",
  requestId: "req_1",
  metadata: {},
});

const layer = AuditIntegrityLive.pipe(
  Layer.provideMerge(Layer.mergeAll(AuditLogTest, CheckpointStoreTest)),
  Layer.provideMerge(DatabaseTest),
  Layer.merge(TestClock.layer()),
);

const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const commitAll = (actions: readonly string[], orgId?: string) =>
  Effect.flatMap(AuditLog, (audit) =>
    Effect.forEach(actions, (action) => audit.commit(input(action, orgId), () => [])),
  );

const execute = (statement: ReturnType<typeof sql>) =>
  Effect.flatMap(Database, (database) => database.query("raw", (db) => db.run(statement)));

describe("hash chain", () => {
  test("links events per chain", async () => {
    await run(
      Effect.gen(function* () {
        const [first, second] = yield* commitAll(["a.one", "a.two"]);
        const [other] = yield* commitAll(["b.one"], "org_2");

        expect(first?.prevHash).toBeNull();
        expect(second?.prevHash).toBe(first?.hash ?? "");
        expect(other?.prevHash).toBeNull();
      }),
    );
  });

  test("a writer that loses the race fails its batch", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const audit = yield* AuditLog;
        const winner = yield* audit.record(input("a.one"));
        const loser = yield* audit.record(input("a.two"));

        yield* database.batch((db) => [winner.statement(db)]);
        const result = yield* Effect.result(database.batch((db) => [loser.statement(db)]));

        expect(loser.sequence).toBe(winner.sequence);
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  test("commit re-records after losing the race", async () => {
    let raced = false;

    // A Database whose first batch is preceded by a competing writer's commit.
    const racingDatabase = Layer.effect(
      Database,
      Effect.map(Database, (base) => ({
        ...base,
        batch: ((statements) => {
          if (raced) return base.batch(statements);
          raced = true;

          return base
            .batch((db) => [
              db.insert(schema.auditEvent).values({
                id: "racer",
                ts: 0,
                schemaVersion: 1,
                payload: {},
                chain: "org:org_1",
                sequence: 1,
                hash: "racer-hash",
              }),
            ])
            .pipe(Effect.andThen(base.batch(statements)));
        }) satisfies DatabaseService["batch"],
      })),
    );

    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
    const event = await Effect.runPromise(
      Effect.flatMap(AuditLog, (audit) => audit.commit(input("a.mine"), () => [])).pipe(
        Effect.provide(
          AuditLogTest.pipe(Layer.provide(racingDatabase), Layer.provide(DatabaseTest)),
        ),
      ),
    );

    expect(raced).toBe(true);
    expect(event.prevHash).toBe("racer-hash");
  });

  test("commit returns failures of the change without retrying", async () => {
    await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const database = yield* Database;

        const result = yield* Effect.result(
          audit.commit(input("a.one"), (db) => [db.run(sql`insert into missing_table values (1)`)]),
        );

        expect(result._tag).toBe("Failure");
        const rows = yield* database.query("rows", (db) => db.select().from(schema.auditEvent));

        expect(rows).toEqual([]);
      }),
    );
  });

  test("prune keeps each chain's head", async () => {
    await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* commitAll(["a.one", "a.two"]);
        yield* audit.drainOutbox();
        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);

        yield* (yield* AuditIntegrity).writeCheckpoints;
        expect(yield* audit.prune()).toBe(1);
        const [next] = yield* commitAll(["a.three"]);
        expect((yield* (yield* AuditIntegrity).verify).mismatches).toEqual([]);
        expect(next?.prevHash).not.toBeNull();
      }),
    );
  });
});

describe("verifier", () => {
  test("passes an untouched log and its checkpoints", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        yield* commitAll(["a.one", "a.two"]);
        yield* commitAll(["b.one"], "org_2");

        const written = yield* integrity.writeCheckpoints;
        const report = yield* integrity.verify;

        expect(written.map((checkpoint) => [checkpoint.scope, checkpoint.count])).toEqual([
          ["org:org_1", 2],
          ["org:org_2", 1],
        ]);
        expect(report).toMatchObject({ chains: 2, events: 3, mismatches: [] });
      }),
    );
  });

  test("checkpoints are write-once per day", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        yield* commitAll(["a.one"]);
        yield* integrity.writeCheckpoints;

        expect((yield* Effect.result(integrity.writeCheckpoints))._tag).toBe("Success");
      }),
    );
  });

  test("detects a deleted checkpointed prefix inside retention", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        yield* commitAll(Array.from({ length: 15 }, (_, i) => `a.${i}`));
        yield* integrity.writeCheckpoints;
        yield* commitAll(Array.from({ length: 5 }, (_, i) => `b.${i}`));
        yield* execute(sql`delete from audit_event where sequence < 20`);
        expect((yield* integrity.verify).mismatches.length).toBeGreaterThan(0);
      }),
    );
  });

  test.each(["org_id", "ts"])("detects %s column tampering", async (column) => {
    await run(
      Effect.gen(function* () {
        yield* commitAll(["a.one"]);
        yield* execute(
          sql.raw(`update audit_event set ${column} = ${column === "ts" ? "1" : "'hidden'"}`),
        );
        expect((yield* (yield* AuditIntegrity).verify).mismatches.length).toBeGreaterThan(0);
      }),
    );
  });

  test("old missing rows still require export evidence", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        yield* commitAll(["a.one", "a.two"]);
        yield* integrity.writeCheckpoints;
        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);
        yield* execute(sql`delete from audit_event where sequence = 1`);
        expect((yield* integrity.verify).mismatches.length).toBeGreaterThan(0);
      }),
    );
  });

  test("checks the first survivor against its preceding checkpoint", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        yield* commitAll(["a.one"]);
        yield* (yield* AuditLog).drainOutbox();
        yield* integrity.writeCheckpoints;
        yield* commitAll(["a.two"]);
        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);
        yield* (yield* AuditLog).prune();
        yield* execute(sql`update audit_event set prev_hash = 'forged' where sequence = 2`);
        expect((yield* integrity.verify).mismatches.map((m) => m.reason)).toContain(
          "previous hash does not match checkpoint",
        );
      }),
    );
  });

  test("detects an edited payload", async () => {
    await run(
      Effect.gen(function* () {
        yield* commitAll(["a.one", "a.two"]);
        yield* execute(
          sql`update audit_event set payload = json_set(payload, '$.action', 'a.forged') where sequence = 1`,
        );

        const { mismatches } = yield* (yield* AuditIntegrity).verify;
        expect(mismatches).toEqual([
          { chain: "org:org_1", sequence: 1, reason: "hash does not match payload" },
        ]);
      }),
    );
  });

  test("detects a rehashed edit through the next link", async () => {
    await run(
      Effect.gen(function* () {
        const [first] = yield* commitAll(["a.one", "a.two"]);
        const forged = "f".repeat(64);
        yield* execute(
          sql`update audit_event set hash = ${forged}, payload = json_set(payload, '$.hash', ${forged}) where id = ${first?.id ?? ""}`,
        );

        const reasons = (yield* (yield* AuditIntegrity).verify).mismatches.map(
          (mismatch) => mismatch.reason,
        );

        expect(reasons).toContain("previous hash does not match the preceding event");
      }),
    );
  });

  test("detects a deleted event", async () => {
    await run(
      Effect.gen(function* () {
        yield* commitAll(["a.one", "a.two", "a.three"]);
        yield* execute(sql`delete from audit_event where sequence = 2`);

        const reasons = (yield* (yield* AuditIntegrity).verify).mismatches.map(
          (mismatch) => mismatch.reason,
        );

        expect(reasons).toContain("sequence gap after 1");
      }),
    );
  });

  test("detects events truncated after a checkpoint, and records the failure", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        const database = yield* Database;
        yield* commitAll(["a.one", "a.two"]);
        yield* integrity.writeCheckpoints;
        yield* execute(sql`delete from audit_event where sequence = 2`);

        const report = yield* integrity.verifyAndRecord;

        const recorded = yield* database.query("instance", (db) =>
          db.select().from(schema.auditEvent).where(eq(schema.auditEvent.chain, "instance")),
        );

        expect(report.mismatches.map((mismatch) => mismatch.reason)).toEqual([
          expect.stringContaining("checkpoint are missing"),
        ]);
        expect(recorded.map((row) => row.payload.action)).toEqual(["audit.integrity.failed"]);
      }),
    );
  });
});

test("R2 checkpoint store is create-only and lists every page", async () => {
  const objects = new Map<string, string>();

  const bucket: CheckpointBucket = {
    put: async (key, value) => {
      if (objects.has(key)) return null;
      objects.set(key, value);

      return {};
    },
    get: async (key) => {
      const value = objects.get(key);

      return value === undefined ? null : { text: async () => value };
    },
    list: async ({ prefix, cursor }) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0);

      return {
        objects: keys.slice(start, start + 1).map((key) => ({ key })),
        truncated: start + 1 < keys.length,
        cursor: String(start + 1),
      };
    },
  };

  const store = makeCheckpointStore(bucket);

  const checkpoint = {
    scope: "instance",
    lastId: "id",
    lastHash: "h",
    count: 1,
    date: "2026-10-24",
  };

  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* store.put(checkpoint);
      yield* store.put({ ...checkpoint, scope: "org:a" });

      expect((yield* Effect.result(store.put(checkpoint)))._tag).toBe("Success");
      expect((yield* Effect.result(store.put({ ...checkpoint, lastHash: "conflict" })))._tag).toBe(
        "Failure",
      );
      expect((yield* store.list).map((each) => each.scope)).toEqual(["instance", "org:a"]);
    }),
  );
});

describe("jobs", () => {
  test("a partial checkpoint write does not skip later chains", async () => {
    const attempted: string[] = [];

    const failingStore = Layer.effect(
      CheckpointStore,
      Effect.map(CheckpointStore, (store) => ({
        ...store,
        put: (checkpoint: Parameters<typeof store.put>[0]) => {
          attempted.push(checkpoint.scope);

          return checkpoint.scope === "org:org_1"
            ? Effect.fail(new CheckpointStoreError({ cause: "unavailable" }))
            : store.put(checkpoint);
        },
      })),
    ).pipe(Layer.provide(CheckpointStoreTest));

    const failingLayer = AuditIntegrityLive.pipe(
      Layer.provideMerge(Layer.mergeAll(AuditLogTest, failingStore)),
      Layer.provideMerge(DatabaseTest),
    );

    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* commitAll(["a.one"]);
        yield* commitAll(["b.one"], "org_2");
        const result = yield* Effect.result((yield* AuditIntegrity).writeCheckpoints);
        expect(result._tag).toBe("Failure");
        expect(attempted).toEqual(["org:org_1", "org:org_2"]);
        expect((yield* (yield* CheckpointStore).list).map((c) => c.scope)).toEqual(["org:org_2"]);
      }).pipe(Effect.provide(failingLayer)),
    );
  });

  test("same-day daily retries verify and prune after the chain grows", async () => {
    await run(
      Effect.gen(function* () {
        yield* commitAll(["a.one"]);
        expect((yield* dailyAuditJob).report.events).toBe(1);
        yield* commitAll(["a.two"]);
        expect((yield* dailyAuditJob).report.events).toBe(2);
        expect((yield* (yield* AuditIntegrity).writeCheckpoints)[0]?.count).toBe(1);
      }),
    );
  });

  test("checkpoint failure still verifies and prunes, then surfaces the error", async () => {
    await run(
      Effect.gen(function* () {
        const integrity = yield* AuditIntegrity;
        const audit = yield* AuditLog;
        let verified = false;
        let pruned = false;
        yield* commitAll(["a.one", "a.two"]);
        yield* audit.drainOutbox();
        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);
        const failure = new CheckpointStoreError({ cause: "partial failure" });

        const result = yield* Effect.result(
          dailyAuditJob.pipe(
            Effect.provideService(AuditIntegrity, {
              ...integrity,
              writeCheckpoints: integrity.writeCheckpoints.pipe(
                Effect.andThen(Effect.fail(failure)),
              ),
              verifyAndRecord: integrity.verifyAndRecord.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    verified = true;
                  }),
                ),
              ),
            }),
            Effect.provideService(AuditLog, {
              ...audit,
              prune: () =>
                audit.prune().pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      pruned = true;
                    }),
                  ),
                ),
            }),
          ),
        );

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) expect(result.failure).toBe(failure);
        expect(verified).toBe(true);
        expect(pruned).toBe(true);
        expect((yield* integrity.verify).events).toBe(1);
      }),
    );
  });

  test("drain exports the whole outbox; daily checkpoints, verifies and prunes", async () => {
    await run(
      Effect.gen(function* () {
        yield* commitAll(Array.from({ length: 150 }, (_, index) => `a.${index}`));

        expect(yield* drainOutboxJob).toBe(150);
        expect((yield* (yield* AuditSinkMemory).events).length).toBe(150);

        yield* TestClock.adjust(AUDIT_RETENTION_MILLIS + 1);
        const { report, pruned } = yield* dailyAuditJob;

        expect(report.mismatches).toEqual([]);
        expect(pruned).toBe(149);
      }),
    );
  });
});
