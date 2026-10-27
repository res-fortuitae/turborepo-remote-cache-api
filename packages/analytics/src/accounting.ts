import { Database, schema } from "@repo/db";
import { and, eq, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { AnalyticsError, type AnalyticsScope } from "./emitter.ts";

export class ActivityFlags extends Context.Service<
  ActivityFlags,
  {
    readonly get: (key: string) => Effect.Effect<string | null, unknown>;
    readonly put: (key: string, value: string, ttl: number) => Effect.Effect<void, unknown>;
  }
>()("@repo/analytics/ActivityFlags") {}

export class AnalyticsActivity extends Context.Service<
  AnalyticsActivity,
  {
    readonly seen: (scope: AnalyticsScope, hit: boolean) => Effect.Effect<void, AnalyticsError>;
  }
>()("@repo/analytics/AnalyticsActivity") {}

/** KV is only a throttle; durable signals use idempotent min/max updates in D1. */
export const AnalyticsActivityLive = Layer.effect(
  AnalyticsActivity,
  Effect.gen(function* () {
    const db = yield* Database;
    const flags = yield* ActivityFlags;
    return {
      seen: (scope, hit) =>
        Effect.gen(function* () {
          const key = `analytics-activity:${scope.orgId}:${scope.projectId}:${hit ? "hit" : "seen"}`;
          if (yield* flags.get(key).pipe(Effect.catch(() => Effect.succeed(null)))) return;
          const now = yield* Clock.currentTimeMillis;
          yield* db.query("Analytics.activity", (db) =>
            db
              .update(schema.project)
              .set({
                lastSeenAt: sql`max(coalesce(${schema.project.lastSeenAt}, 0), ${now})`,
                ...(hit ? { firstHitAt: sql`coalesce(${schema.project.firstHitAt}, ${now})` } : {}),
              })
              .where(
                and(eq(schema.project.id, scope.projectId), eq(schema.project.orgId, scope.orgId)),
              ),
          );
          yield* flags.put(key, "1", 3600).pipe(Effect.catch(() => Effect.void));
        }).pipe(Effect.mapError((cause) => new AnalyticsError({ cause }))),
    };
  }),
);

export class StorageAccounting extends Context.Service<
  StorageAccounting,
  {
    /** null removes an object. Repeat observations of the same object size do not add bytes twice. */
    readonly record: (
      scope: AnalyticsScope,
      hash: string,
      bytes: number | null,
    ) => Effect.Effect<void, AnalyticsError>;
  }
>()("@repo/analytics/StorageAccounting") {}
export const StorageAccountingLive = Layer.effect(
  StorageAccounting,
  Effect.gen(function* () {
    const database = yield* Database;
    return {
      record: (scope, hash, bytes) => {
        const where = and(
          eq(schema.artifactUsage.orgId, scope.orgId),
          eq(schema.artifactUsage.projectId, scope.projectId),
          eq(schema.artifactUsage.hash, hash),
        );
        const totalWhere = and(
          eq(schema.projectUsage.orgId, scope.orgId),
          eq(schema.projectUsage.projectId, scope.projectId),
        );
        const size = bytes === null ? 0 : Math.max(0, Math.floor(bytes));
        return database
          .batch((db) => [
            db
              .insert(schema.projectUsage)
              .values({ orgId: scope.orgId, projectId: scope.projectId, bytes: 0 })
              .onConflictDoNothing(),
            db
              .update(schema.projectUsage)
              .set({
                bytes: sql`max(0, ${schema.projectUsage.bytes} + ${size} - coalesce((select bytes from artifact_usage where org_id = ${scope.orgId} and project_id = ${scope.projectId} and hash = ${hash}), 0))`,
              })
              .where(totalWhere),
            bytes === null
              ? db.delete(schema.artifactUsage).where(where)
              : db
                  .insert(schema.artifactUsage)
                  .values({ orgId: scope.orgId, projectId: scope.projectId, hash, bytes: size })
                  .onConflictDoUpdate({
                    target: [
                      schema.artifactUsage.orgId,
                      schema.artifactUsage.projectId,
                      schema.artifactUsage.hash,
                    ],
                    set: { bytes: size },
                  }),
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new AnalyticsError({ cause })),
          );
      },
    };
  }),
);
