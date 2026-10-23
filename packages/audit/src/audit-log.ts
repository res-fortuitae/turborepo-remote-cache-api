import { AuditEvent } from "@repo/api-spec";
import {
  Database,
  type DatabaseBatch,
  type DatabaseQueries,
  type DatabaseStatement,
  schema,
} from "@repo/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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

/** Retries when a concurrent writer extends the same chain first. */
export const CHAIN_RETRIES = 5;

/**
 * A recorded event and the insert that persists it inside the caller's batch.
 * The insert takes the next `sequence` on `chain`; if another writer took it
 * first, the batch fails and the caller records again (or uses `commit`).
 */
export interface AuditRecord {
  readonly event: AuditEvent;
  readonly chain: string;
  readonly sequence: number;
  readonly statement: (db: DatabaseQueries) => DatabaseStatement;
}

/** One chain per org, and one for instance-wide events. */
export const chainOf = (input: Pick<AuditInput, "scope" | "orgId">) =>
  input.scope === "org" && input.orgId !== undefined ? `org:${input.orgId}` : "instance";

export interface AuditLogService {
  /**
   * Builds the event and its outbox insert. Callers put `statement` in the same
   * `Database.batch` as the change it describes, so both commit or neither does.
   */
  readonly record: (input: AuditInput) => Effect.Effect<AuditRecord, AuditLogError>;
  /**
   * Commits `change` and the event in one batch, re-recording on a lost chain
   * race. Failures of the change itself are returned, not retried.
   */
  readonly commit: (
    input: AuditInput,
    change: (db: DatabaseQueries) => readonly DatabaseStatement[],
  ) => Effect.Effect<AuditEvent, AuditLogError>;
  /**
   * Sends an event straight to the sink, without a D1 row. For high-volume
   * denials that change nothing; run it under `waitUntil`.
   */
  readonly recordStandalone: (input: AuditInput) => Effect.Effect<AuditEvent, AuditSinkError>;
  /** Exports the oldest unexported rows in order and marks them exported. Returns the count. */
  readonly drainOutbox: (limit?: number) => Effect.Effect<number, AuditLogError | AuditSinkError>;
  /**
   * Deletes exported rows older than the retention window, except each chain's
   * head. Returns the count.
   */
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

/** `SHA-256(prevHash || canonicalJson(event))`, over the event without its own `hash`. */
export const hashEvent = (event: Omit<AuditEvent, "hash">) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode((event.prevHash ?? "") + canonicalJson(event)),
    ),
  ).pipe(Effect.map(toHex));

export const decodeEvent = Schema.decodeUnknownEffect(AuditEvent);

const build = Effect.fn("AuditLog.build")(function* (input: AuditInput, prevHash: string | null) {
  const now = yield* Clock.currentTimeMillis;

  const unhashed = {
    ...input,
    id: ulid(now),
    ts: new Date(now).toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    prevHash,
  } satisfies Omit<AuditEvent, "hash">;

  return { ...unhashed, hash: yield* hashEvent(unhashed) } satisfies AuditEvent;
});

const insert =
  (event: AuditEvent, chain: string, sequence: number) =>
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
      chain,
      sequence,
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

    const head = (chain: string) =>
      database
        .query("AuditLog.head", (db) =>
          db
            .select({ sequence: schema.auditEvent.sequence, hash: schema.auditEvent.hash })
            .from(schema.auditEvent)
            .where(eq(schema.auditEvent.chain, chain))
            .orderBy(desc(schema.auditEvent.sequence))
            .limit(1),
        )
        .pipe(
          fromDatabase,
          Effect.map(([row]) => ({ sequence: row?.sequence ?? 0, hash: row?.hash ?? null })),
        );

    const record = Effect.fn("AuditLog.record")(function* (input: AuditInput) {
      const chain = chainOf(input);
      const previous = yield* head(chain);
      const event = yield* build(input, previous.hash);
      const sequence = previous.sequence + 1;

      return { event, chain, sequence, statement: insert(event, chain, sequence) };
    });

    return {
      record,
      commit: Effect.fn("AuditLog.commit")(function* (input, change) {
        for (let attempt = 0; ; attempt++) {
          const recorded = yield* record(input);

          const result = yield* Effect.result(
            database.batch((db): DatabaseBatch => [recorded.statement(db), ...change(db)]),
          );

          if (Result.isSuccess(result)) return recorded.event;

          // Retry only if another writer took this sequence; otherwise the change failed.
          const lost = (yield* head(recorded.chain)).sequence >= recorded.sequence;

          if (!lost || attempt >= CHAIN_RETRIES)
            return yield* new AuditLogError({
              operation: result.failure.operation,
              cause: result.failure.cause,
            });
        }
      }),
      recordStandalone: Effect.fn("AuditLog.recordStandalone")(function* (input) {
        // No row and no chain position: standalone events are not chained.
        const event = yield* build(input, null);
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
              .where(
                and(
                  isNotNull(schema.auditEvent.exportedAt),
                  lt(schema.auditEvent.ts, cutoff),
                  // A chain's head is kept, so the next event still links to it.
                  sql`exists (select 1 from audit_event later where later.chain = audit_event.chain and later.sequence > audit_event.sequence)`,
                ),
              )
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
