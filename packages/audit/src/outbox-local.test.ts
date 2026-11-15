import { expect, test } from "bun:test";
import { DatabaseLocalTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AuditLog, AuditSinkMemory } from "./audit-log.ts";
import { AuditLogTest } from "./testing.ts";
import { drainOutboxJob } from "./jobs.ts";

test("local D1 exports a 150-event backlog and prunes acknowledged history", async () => {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Bun test boundary over real local D1.
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      for (let i = 0; i < 150; i++) {
        yield* audit.commit(
          {
            scope: "instance",
            actor: { type: "system", id: "test", display: "Test" },
            action: "test.export",
            target: { type: "test", id: String(i) },
            outcome: "allow",
            ip: "127.0.0.1",
            userAgent: "test",
            requestId: String(i),
            metadata: {},
          },
          () => [],
        );
      }
      expect(yield* drainOutboxJob).toBe(150);
      expect(yield* drainOutboxJob).toBe(0);
      const sent = yield* (yield* AuditSinkMemory).events;
      expect(sent).toHaveLength(150);
      expect(new Set(sent.map((event) => event.id)).size).toBe(150);
      expect(yield* audit.prune(-1)).toBe(149);
    }).pipe(Effect.provide(AuditLogTest.pipe(Layer.provide(DatabaseLocalTest))), Effect.scoped),
  );
}, 30000);
