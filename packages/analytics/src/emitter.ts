import type { CacheEvent } from "@repo/api-spec";
import { Database, schema } from "@repo/db";
import { sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface AnalyticsScope {
  readonly orgId: string;
  readonly projectId: string;
}

export class AnalyticsError extends Schema.TaggedError<AnalyticsError>()("AnalyticsError", {
  cause: Schema.Unknown,
}) {}

export interface AnalyticsEmitterService {
  readonly emit: (
    scope: AnalyticsScope,
    events: readonly CacheEvent[],
  ) => Effect.Effect<void, AnalyticsError>;
}

export class AnalyticsEmitter extends Context.Service<AnalyticsEmitter, AnalyticsEmitterService>()(
  "@repo/analytics/AnalyticsEmitter",
) {}

export const AnalyticsEmitterDisabled = Layer.succeed(AnalyticsEmitter, {
  emit: () => Effect.void,
});

/** One atomic upsert per metric per submitted batch, never a write per cache event. */
export const AnalyticsEmitterLite = Layer.effect(
  AnalyticsEmitter,
  Effect.gen(function* () {
    const database = yield* Database;

    return {
      emit: Effect.fn("AnalyticsEmitterLite.emit")(function* (
        scope: AnalyticsScope,
        events: readonly CacheEvent[],
      ) {
        if (events.length === 0) return;
        const now = yield* Clock.currentTimeMillis;
        const bucketStart = Math.floor(now / 3_600_000) * 3_600_000;
        let remoteHits = 0;
        let remoteMisses = 0;
        let timeSavedMs = 0;

        for (const event of events) {
          if (event.source !== "REMOTE") continue;

          if (event.event === "HIT") {
            remoteHits++;

            if (
              event.duration !== undefined &&
              Number.isSafeInteger(event.duration) &&
              event.duration > 0
            )
              timeSavedMs += event.duration;
          } else remoteMisses++;
        }

        const metrics = {
          requests: remoteHits + remoteMisses,
          remoteHits,
          remoteMisses,
          timeSavedMs,
        };

        const rows = Object.entries(metrics)
          .filter(([, value]) => value > 0)
          .map(([metric, value]) => ({ ...scope, bucketStart, metric, value }));

        if (rows.length === 0) return;
        yield* database
          .query("AnalyticsEmitterLite.upsert", (db) =>
            db
              .insert(schema.rollup)
              .values(rows)
              .onConflictDoUpdate({
                target: [
                  schema.rollup.orgId,
                  schema.rollup.projectId,
                  schema.rollup.bucketStart,
                  schema.rollup.metric,
                ],
                set: { value: sql`${schema.rollup.value} + excluded.value` },
              }),
          )
          .pipe(Effect.mapError((cause) => new AnalyticsError({ cause })));
      }),
    } satisfies AnalyticsEmitterService;
  }),
);
