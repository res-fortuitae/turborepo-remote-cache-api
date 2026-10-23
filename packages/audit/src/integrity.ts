import { Database, schema } from "@repo/db";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AuditLog, AuditLogError, decodeEvent, hashEvent } from "./audit-log.ts";

/** A chain's head on a given UTC day. `count` is the head's sequence number. */
export const Checkpoint = Schema.Struct({
  scope: Schema.NonEmptyString,
  lastId: Schema.NonEmptyString,
  lastHash: Schema.NonEmptyString,
  count: Schema.Int,
  date: Schema.String,
});

export type Checkpoint = typeof Checkpoint.Type;

export class CheckpointStoreError extends Schema.TaggedError<CheckpointStoreError>()(
  "CheckpointStoreError",
  { cause: Schema.Unknown },
) {}

/** Write-once checkpoint storage; the live store is a locked R2 bucket. */
export interface CheckpointStoreService {
  /** Stores a checkpoint. Writing the same day and scope again fails. */
  readonly put: (checkpoint: Checkpoint) => Effect.Effect<void, CheckpointStoreError>;
  readonly list: Effect.Effect<readonly Checkpoint[], CheckpointStoreError>;
}

export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreService>()(
  "@repo/audit/CheckpointStore",
) {}

/** The R2 bucket operations the checkpoint store uses. */
export interface CheckpointBucket {
  readonly put: (
    key: string,
    value: string,
    options: { readonly onlyIf: { readonly etagDoesNotMatch: string } },
  ) => Promise<object | null>;
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly list: (options: { readonly prefix: string; readonly cursor?: string }) => Promise<{
    readonly objects: readonly { readonly key: string }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/** Objects under this prefix are covered by the bucket's lock rule. */
export const CHECKPOINT_PREFIX = "checkpoints/";

export const checkpointKey = (checkpoint: Pick<Checkpoint, "date" | "scope">) =>
  `${CHECKPOINT_PREFIX}${checkpoint.date}/${checkpoint.scope}.json`;

const decodeCheckpoint = Schema.decodeUnknownEffect(Schema.fromJsonString(Checkpoint));

export const makeCheckpointStore = (bucket: CheckpointBucket): CheckpointStoreService => {
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new CheckpointStoreError({ cause }) });

  return {
    put: Effect.fn("CheckpointStore.put")(function* (checkpoint) {
      // Create-only; the bucket lock also rejects overwrites.
      const stored = yield* attempt(() =>
        bucket.put(checkpointKey(checkpoint), JSON.stringify(checkpoint), {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      );

      if (stored === null)
        return yield* new CheckpointStoreError({ cause: "Checkpoint already exists" });
    }),
    list: Effect.gen(function* () {
      const keys: string[] = [];
      let cursor: string | undefined;

      do {
        const page = yield* attempt(() => bucket.list({ prefix: CHECKPOINT_PREFIX, cursor }));
        keys.push(...page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);

      return yield* Effect.forEach(keys, (key) =>
        Effect.gen(function* () {
          const object = yield* attempt(() => bucket.get(key));

          if (object === null)
            return yield* new CheckpointStoreError({ cause: `Checkpoint ${key} vanished` });

          return yield* decodeCheckpoint(yield* attempt(() => object.text())).pipe(
            Effect.mapError((cause) => new CheckpointStoreError({ cause })),
          );
        }),
      );
    }),
  };
};

/** Write-once, in memory. */
export const CheckpointStoreTest: Layer.Layer<CheckpointStore> = Layer.effect(
  CheckpointStore,
  Effect.gen(function* () {
    const stored = yield* Ref.make(new Map<string, Checkpoint>());

    return {
      put: (checkpoint) =>
        Effect.flatMap(Ref.get(stored), (map) =>
          map.has(checkpointKey(checkpoint))
            ? Effect.fail(new CheckpointStoreError({ cause: "Checkpoint already exists" }))
            : Ref.set(stored, new Map(map).set(checkpointKey(checkpoint), checkpoint)),
        ),
      list: Effect.map(Ref.get(stored), (map) => [...map.values()]),
    };
  }),
);

export interface IntegrityMismatch {
  readonly chain: string;
  readonly sequence: number | null;
  readonly reason: string;
}

export interface IntegrityReport {
  readonly verifiedAt: string;
  readonly chains: number;
  readonly events: number;
  readonly mismatches: readonly IntegrityMismatch[];
}

export interface AuditIntegrityService {
  /** Writes today's head of every chain. Returns the checkpoints written. */
  readonly writeCheckpoints: Effect.Effect<
    readonly Checkpoint[],
    AuditLogError | CheckpointStoreError
  >;
  /** Re-walks every chain in D1 and compares it with the checkpoints. */
  readonly verify: Effect.Effect<IntegrityReport, AuditLogError | CheckpointStoreError>;
  /** `verify`, recording an `audit.integrity.failed` event if anything mismatches. */
  readonly verifyAndRecord: Effect.Effect<IntegrityReport, AuditLogError | CheckpointStoreError>;
}

export class AuditIntegrity extends Context.Service<AuditIntegrity, AuditIntegrityService>()(
  "@repo/audit/AuditIntegrity",
) {}

const VERIFY_PAGE_SIZE = 1000;

export const AuditIntegrityLive: Layer.Layer<
  AuditIntegrity,
  never,
  Database | CheckpointStore | AuditLog
> = Layer.effect(
  AuditIntegrity,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* CheckpointStore;
    const audit = yield* AuditLog;

    const query = <A>(operation: string, run: Parameters<typeof database.query<A>>[1]) =>
      database
        .query(operation, run)
        .pipe(
          Effect.mapError(
            (error) => new AuditLogError({ operation: error.operation, cause: error.cause }),
          ),
        );

    const heads = query("AuditIntegrity.heads", (db) =>
      db
        .select({
          chain: schema.auditEvent.chain,
          sequence: schema.auditEvent.sequence,
          id: schema.auditEvent.id,
          hash: schema.auditEvent.hash,
        })
        .from(schema.auditEvent)
        .where(
          and(
            isNotNull(schema.auditEvent.chain),
            sql`not exists (select 1 from audit_event later where later.chain = audit_event.chain and later.sequence > audit_event.sequence)`,
          ),
        )
        .orderBy(asc(schema.auditEvent.chain)),
    );

    const walk = Effect.fn("AuditIntegrity.walk")(function* (chain: string) {
      const mismatches: IntegrityMismatch[] = [];
      const hashes = new Map<number, { id: string; hash: string | null }>();
      let previous: { sequence: number; hash: string | null } | undefined;

      for (;;) {
        const after = previous?.sequence ?? 0;

        const rows = yield* query("AuditIntegrity.walk", (db) =>
          db
            .select()
            .from(schema.auditEvent)
            .where(and(eq(schema.auditEvent.chain, chain), gt(schema.auditEvent.sequence, after)))
            .orderBy(asc(schema.auditEvent.sequence))
            .limit(VERIFY_PAGE_SIZE),
        );

        for (const row of rows) {
          const sequence = row.sequence ?? 0;
          const mismatch = (reason: string) => mismatches.push({ chain, sequence, reason });

          hashes.set(sequence, { id: row.id, hash: row.hash });

          // Pruning removes a chain's oldest rows, so the first row present is trusted to link.
          if (previous === undefined && sequence === 1 && row.prevHash !== null)
            mismatch("first event has a previous hash");

          if (previous !== undefined && sequence !== previous.sequence + 1)
            mismatch(`sequence gap after ${previous.sequence}`);

          if (previous !== undefined && row.prevHash !== previous.hash)
            mismatch("previous hash does not match the preceding event");

          const decoded = yield* Effect.result(decodeEvent(row.payload));

          if (Result.isFailure(decoded)) mismatch("payload is not a valid event");
          else {
            const { hash, ...unhashed } = decoded.success;

            if (hash !== row.hash || unhashed.prevHash !== row.prevHash || unhashed.id !== row.id)
              mismatch("payload does not match its row");

            if ((yield* hashEvent(unhashed)) !== row.hash) mismatch("hash does not match payload");
          }

          previous = { sequence, hash: row.hash };
        }

        if (rows.length < VERIFY_PAGE_SIZE) break;
      }

      return { mismatches, hashes, head: previous?.sequence ?? 0 };
    });

    const verify = Effect.gen(function* () {
      const verifiedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const checkpoints = yield* store.list;

      const chains = new Set([
        ...(yield* heads).flatMap((head) => (head.chain === null ? [] : [head.chain])),
        ...checkpoints.map((checkpoint) => checkpoint.scope),
      ]);

      const mismatches: IntegrityMismatch[] = [];
      let events = 0;

      for (const chain of [...chains].sort()) {
        const walked = yield* walk(chain);
        mismatches.push(...walked.mismatches);
        events += walked.hashes.size;

        for (const checkpoint of checkpoints.filter((each) => each.scope === chain)) {
          const row = walked.hashes.get(checkpoint.count);

          const mismatch = (reason: string) =>
            mismatches.push({ chain, sequence: checkpoint.count, reason });

          if (checkpoint.count > walked.head)
            mismatch(`events after the ${checkpoint.date} checkpoint are missing`);
          else if (
            row !== undefined &&
            (row.id !== checkpoint.lastId || row.hash !== checkpoint.lastHash)
          )
            mismatch(`event differs from the ${checkpoint.date} checkpoint`);
          // A checkpointed event older than the D1 window was pruned; Iceberg holds it.
        }
      }

      return { verifiedAt, chains: chains.size, events, mismatches } satisfies IntegrityReport;
    });

    return {
      writeCheckpoints: Effect.gen(function* () {
        const date = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10);

        const checkpoints = (yield* heads).flatMap((head) =>
          head.chain === null || head.sequence === null || head.hash === null
            ? []
            : [
                {
                  scope: head.chain,
                  lastId: head.id,
                  lastHash: head.hash,
                  count: head.sequence,
                  date,
                },
              ],
        );

        yield* Effect.forEach(checkpoints, store.put, { discard: true });

        return checkpoints;
      }),
      verify,
      verifyAndRecord: Effect.gen(function* () {
        const report = yield* verify;

        if (report.mismatches.length > 0)
          yield* audit.commit(
            {
              scope: "instance",
              actor: { type: "system", id: "audit-verifier", display: "Audit verifier" },
              action: "audit.integrity.failed",
              target: { type: "audit_log", id: "instance" },
              outcome: "error",
              reason: `${report.mismatches.length} mismatch(es)`,
              ip: "",
              userAgent: "",
              requestId: report.verifiedAt,
              metadata: {
                mismatches: report.mismatches.map((mismatch) => ({ ...mismatch })),
              },
            },
            () => [],
          );

        return report;
      }),
    };
  }),
);
