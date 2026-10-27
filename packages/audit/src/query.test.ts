/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { DatabaseTest } from "@repo/db/testing";
import { AuditLog, AuditLogLive, AuditSinkTest, type AuditInput } from "./audit-log.ts";
import {
  AuditHistory,
  AuditHistoryDisabled,
  AuditReader,
  AuditReaderLive,
  auditHistorySql,
  validateAuditSelection,
} from "./query.ts";
import { Effect, Layer, Stream } from "effect";

const range = { from: "2020-01-01T00:00:00.000Z", to: "2099-01-01T00:00:00.000Z" };
const input = (orgId: string): AuditInput => ({
  scope: "org",
  orgId,
  actor: { type: "user", id: "actor", display: "Actor" },
  action: "project.created",
  target: { type: "project", id: "target" },
  outcome: "allow",
  ip: "",
  userAgent: "",
  requestId: "request",
  metadata: {},
});
const layers = Layer.mergeAll(
  AuditLogLive.pipe(Layer.provide(AuditSinkTest)),
  AuditReaderLive.pipe(Layer.provide(AuditHistoryDisabled)),
).pipe(Layer.provideMerge(DatabaseTest));

test("org scope, filters, tied timestamps, cursors and multi-page export preserve every event exactly once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const reader = yield* AuditReader;
      for (let i = 0; i < 105; i++) yield* audit.commit(input("org-a"), () => []);
      yield* audit.commit(input("org-b"), () => []);
      const first = yield* reader.page("org-a", { ...range, limit: 10 });
      expect(first.items).toHaveLength(10);
      expect(first.items.every((item) => item.orgId === "org-a")).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const second = yield* reader.page("org-a", { ...range, limit: 10, cursor: first.nextCursor });
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(20);
      expect(
        (yield* Effect.result(reader.page("org-b", { ...range, cursor: first.nextCursor })))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          reader.page("org-a", { ...range, action: "other", cursor: first.nextCursor }),
        ))._tag,
      ).toBe("Failure");
      const exported = yield* Stream.runCollect(reader.export("org-a", range));
      expect(exported).toHaveLength(105);
      expect(new Set(exported.map((item) => item.id)).size).toBe(105);
      const remainder = yield* Stream.runCollect(
        reader.export("org-a", { ...range, cursor: first.nextCursor }),
      );
      expect(remainder).toHaveLength(95);
      expect((yield* reader.page("org-a", { ...range, actor: "other" })).items).toHaveLength(0);
      expect((yield* reader.page(undefined, { ...range, limit: 100 })).items).toHaveLength(100);
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));

test("Basin overlap is deduplicated and out-of-scope remote records fail closed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const event = yield* audit.commit(input("org-a"), () => []);
      const archived = {
        ...event,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        ts: "2021-01-01T00:00:00.000Z",
      };
      const reader = yield* Effect.service(AuditReader).pipe(
        Effect.provide(Layer.fresh(AuditReaderLive)),
        Effect.provideService(AuditHistory, {
          read: (selection) =>
            Effect.succeed(
              [event, archived].filter(
                (item) =>
                  !selection.before ||
                  item.ts < selection.before.ts ||
                  (item.ts === selection.before.ts && item.id < selection.before.id),
              ),
            ),
        }),
      );
      expect((yield* reader.page("org-a", range)).items).toHaveLength(2);
      const first = yield* reader.page("org-a", { ...range, limit: 1 });
      const next = yield* reader.page("org-a", { ...range, limit: 1, cursor: first.nextCursor });
      expect(first.items[0]?.id).toBe(event.id);
      expect(next.items[0]?.id).toBe(archived.id);
      expect(next.nextCursor).toBeNull();
      const wrong = yield* Effect.service(AuditReader).pipe(
        Effect.provide(Layer.fresh(AuditReaderLive)),
        Effect.provideService(AuditHistory, {
          read: () => Effect.succeed([{ ...event, orgId: "org-b" }]),
        }),
      );
      expect((yield* Effect.result(wrong.page("org-a", range)))._tag).toBe("Failure");
    }).pipe(Effect.provide(layers), Effect.scoped),
  ));

test("fixed history templates reject SQL syntax in values and always constrain org, dates and limit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { selection } = yield* validateAuditSelection("org-a", {
        ...range,
        actor: "actor",
        action: "project.created",
        outcome: "allow",
      });
      const sql = auditHistorySql(selection, 51);
      expect(sql).toContain("\"orgId\" = 'org-a'");
      expect(sql).toContain("LIMIT 51");
      expect(sql).toContain("ts >= '2020-");
      for (const value of ["x' OR 1=1--", "x;DROP TABLE audit", "x\\y"]) {
        expect(
          (yield* Effect.result(validateAuditSelection("org-a", { ...range, actor: value })))._tag,
        ).toBe("Failure");
        expect(() => auditHistorySql({ ...selection, orgId: value }, 10)).toThrow();
      }
      expect(
        (yield* Effect.result(validateAuditSelection("org-a", { ...range, from: range.to })))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(validateAuditSelection("org-a", { ...range, limit: 101 })))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(validateAuditSelection("org-a", { ...range, cursor: "not-base64" })))
          ._tag,
      ).toBe("Failure");
      expect(() => auditHistorySql(selection, 10000)).toThrow();
    }),
  ));
