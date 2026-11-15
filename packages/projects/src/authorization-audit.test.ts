/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary exercising background delivery. */
import { expect, test } from "bun:test";
import { AuditLogD1Only } from "@repo/audit";
import { AuthorizationAudit } from "@repo/authz";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import { AuthorizationAuditBackground, AuthorizationAuditLive } from "./authorization-audit.ts";

test("authorization denial returns before durable delivery and retains its org filter", async () => {
  const pending: Effect.Effect<void>[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* AuthorizationAudit;
      const database = yield* Database;
      yield* audit.deny(
        { userId: "outsider", sessionId: "session" },
        "read",
        { orgId: "victim" },
        "not-member",
      );
      const rows = () =>
        database.query("test.denials", (db) => db.select().from(schema.auditEvent));
      expect(yield* rows()).toHaveLength(0);
      expect(pending).toHaveLength(1);
      yield* pending[0]!;
      const saved = yield* rows();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.chain).toBe("instance:denials");
      expect(saved[0]?.orgId).toBe("victim");
    }).pipe(
      Effect.provide(
        AuthorizationAuditLive.pipe(
          Layer.provide(
            Layer.succeed(AuthorizationAuditBackground, (effect) =>
              Effect.sync(() => {
                pending.push(effect);
              }),
            ),
          ),
          Layer.provide(AuditLogD1Only),
          Layer.provideMerge(DatabaseTest),
        ),
      ),
      Effect.scoped,
    ),
  );
});
