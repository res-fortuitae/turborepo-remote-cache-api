import { AuditEvent } from "@repo/api-spec";
import { Database, type DatabaseQueries, type DatabaseStatement, schema } from "@repo/db";
import { and, asc, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ulid } from "./ulid.ts";

export const AUDIT_SCHEMA_VERSION = 1;

/** D1 keeps exported events this long; older history lives in the sink. */
export const AUDIT_RETENTION_MILLIS = 90 * 24 * 60 * 60 * 1000;

export const OUTBOX_BATCH_SIZE = 100;

/** What a caller describes; the log assigns `id`, `ts`, the version and the hashes. */
export type AuditInput = Omit<AuditEvent, "id" | "ts" | "schemaVersion" | "prevHash" | "hash">;

export class AuditLogError extends Schema.TaggedError<AuditLogError>()("AuditLogError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

export class AuditSinkError extends Schema.TaggedError<AuditSinkError>()("AuditSinkError", {
  cause: Schema.Unknown,
}) {}

/**
 * The append-only stream events are exported to (Basin Pipelines, STV-459).
 * Delivery is at least once: consumers remove duplicates by `id`.
 */
export interface AuditSinkService {
  readonly send: (events: readonly AuditEvent[]) => Effect.Effect<void, AuditSinkError>;
}

export class AuditSink extends Context.Service<AuditSink, AuditSinkService>()(
  "@repo/audit/AuditSink",
) {}

/** A recorded event and the insert that persists it inside the caller's batch. */
export interface AuditRecord {
  readonly event: AuditEvent;
  readonly statement: (db: DatabaseQueries) => DatabaseStatement;
}

export interface AuditLogService {
  /**
   * Builds the event and its outbox insert. Callers put `statement` in the same
   * `Database.batch` as the change it describes, so both commit or neither does.
   */
  readonly record: (input: AuditInput) => Effect.Effect<AuditRecord, AuditLogError>;
  /**
   * Sends an event straight to the sink, without a D1 row. For high-volume
   * denials that change nothing; run it under `waitUntil`.
   */
  readonly recordStandalone: (input: AuditInput) => Effect.Effect<AuditEvent, AuditSinkError>;
  /** Exports the oldest unexported rows in order and marks them exported. Returns the count. */
  readonly drainOutbox: (limit?: number) => Effect.Effect<number, AuditLogError | AuditSinkError>;
  /** Deletes exported rows older than the retention window. Returns the count. */
  readonly prune: (retentionMillis?: number) => Effect.Effect<number, AuditLogError>;
}

export class AuditLog extends Context.Service<AuditLog, AuditLogService>()(
  "@repo/audit/AuditLog",
) {}

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** JSON with object keys sorted at every level, so equal events hash equally. */
export const canonicalJson = (event: Partial<AuditEvent>): string =>
  JSON.stringify(event, (_key, nested: Schema.Json) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : 1)),
        )
      : nested,
  );

/** SHA-256 over the canonical event without its own `hash`. */
export const hashEvent = (event: Omit<AuditEvent, "hash">) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(event))),
  ).pipe(Effect.map(toHex));

const decodeEvent = Schema.decodeUnknownEffect(AuditEvent);

const build = Effect.fn("AuditLog.build")(function* (input: AuditInput) {
  const now = yield* Clock.currentTimeMillis;

  // prevHash stays null until the hash chain (STV-482) sequences events.
  const unhashed = {
    ...input,
    id: ulid(now),
    ts: new Date(now).toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    prevHash: null,
  } satisfies Omit<AuditEvent, "hash">;

  return { ...unhashed, hash: yield* hashEvent(unhashed) } satisfies AuditEvent;
});

const insert =
  (event: AuditEvent) =>
  (db: DatabaseQueries): DatabaseStatement =>
    db.insert(schema.auditEvent).values({
      id: event.id,
      ts: Date.parse(event.ts),
      schemaVersion: event.schemaVersion,
      orgId: event.orgId ?? null,
      projectId: event.projectId ?? null,
      // Stored canonically: the row is the payload the hash was computed over.
      payload: JSON.parse(canonicalJson(event)),
      prevHash: event.prevHash,
      hash: event.hash,
    });

export const AuditLogLive: Layer.Layer<AuditLog, never, Database | AuditSink> = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const database = yield* Database;
    const sink = yield* AuditSink;

    const fromDatabase = Effect.mapError(
      (error: { readonly operation: string; readonly cause: unknown }) =>
        new AuditLogError({ operation: error.operation, cause: error.cause }),
    );

    return {
      record: Effect.fn("AuditLog.record")(function* (input) {
        const event = yield* build(input);

        return { event, statement: insert(event) };
      }),
      recordStandalone: Effect.fn("AuditLog.recordStandalone")(function* (input) {
        const event = yield* build(input);
        yield* sink.send([event]);

        return event;
      }),
      drainOutbox: Effect.fn("AuditLog.drainOutbox")(function* (limit = OUTBOX_BATCH_SIZE) {
        const rows = yield* database
          .query("AuditLog.drainOutbox", (db) =>
            db
              .select({ id: schema.auditEvent.id, payload: schema.auditEvent.payload })
              .from(schema.auditEvent)
              .where(isNull(schema.auditEvent.exportedAt))
              .orderBy(asc(schema.auditEvent.ts), asc(schema.auditEvent.id))
              .limit(limit),
          )
          .pipe(fromDatabase);

        if (rows.length === 0) return 0;

        const events = yield* Effect.forEach(rows, (row) =>
          decodeEvent(row.payload).pipe(
            Effect.mapError((cause) => new AuditLogError({ operation: "AuditLog.decode", cause })),
          ),
        );

        // Marked only after the sink accepts them, so a failed send is retried.
        yield* sink.send(events);
        const exportedAt = yield* Clock.currentTimeMillis;
        yield* database
          .query("AuditLog.markExported", (db) =>
            db
              .update(schema.auditEvent)
              .set({ exportedAt })
              .where(
                inArray(
                  schema.auditEvent.id,
                  rows.map((row) => row.id),
                ),
              ),
          )
          .pipe(fromDatabase);

        return rows.length;
      }),
      prune: Effect.fn("AuditLog.prune")(function* (retentionMillis = AUDIT_RETENTION_MILLIS) {
        const cutoff = (yield* Clock.currentTimeMillis) - retentionMillis;

        const deleted = yield* database
          .query("AuditLog.prune", (db) =>
            db
              .delete(schema.auditEvent)
              .where(and(isNotNull(schema.auditEvent.exportedAt), lt(schema.auditEvent.ts, cutoff)))
              .returning({ id: schema.auditEvent.id }),
          )
          .pipe(fromDatabase);

        return deleted.length;
      }),
    } satisfies AuditLogService;
  }),
);

/** Fails every send. For hosts with no stream yet: rows wait in the outbox. */
export const AuditSinkUnconfigured: Layer.Layer<AuditSink> = Layer.succeed(AuditSink, {
  send: () => Effect.fail(new AuditSinkError({ cause: "No audit stream is configured" })),
});

/** Keeps sent events in memory, in order. */
export class AuditSinkMemory extends Context.Service<
  AuditSinkMemory,
  { readonly events: Effect.Effect<readonly AuditEvent[]> }
>()("@repo/audit/AuditSinkMemory") {}

export const AuditSinkTest: Layer.Layer<AuditSink | AuditSinkMemory> = Layer.effectContext(
  Effect.gen(function* () {
    const sent = yield* Ref.make<readonly AuditEvent[]>([]);

    return Context.make(AuditSink, {
      send: (events) => Ref.update(sent, (previous) => [...previous, ...events]),
    }).pipe(Context.add(AuditSinkMemory, { events: Ref.get(sent) }));
  }),
);
