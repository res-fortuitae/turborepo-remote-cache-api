import { Database, schema } from "@repo/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { AnalyticsError } from "./emitter.ts";
import { StorageAccounting } from "./accounting.ts";

export class AnalyticsInventory extends Context.Service<
  AnalyticsInventory,
  {
    readonly list: (
      prefix: string,
      cursor?: string,
    ) => Effect.Effect<
      {
        readonly objects: readonly { readonly key: string; readonly size: number }[];
        readonly cursor?: string;
      },
      AnalyticsError
    >;
  }
>()("@repo/analytics/AnalyticsInventory") {}
export class StorageReconciliation extends Context.Service<
  StorageReconciliation,
  {
    readonly tick: Effect.Effect<void, AnalyticsError>;
  }
>()("@repo/analytics/StorageReconciliation") {}

/** One project × one 10-object page per tick. Completed projects are revisited after 24 hours. */
export const StorageReconciliationLive = Layer.effect(
  StorageReconciliation,
  Effect.gen(function* () {
    const db = yield* Database;
    const inventory = yield* AnalyticsInventory;
    const accounting = yield* StorageAccounting;
    return {
      tick: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const projects = yield* db.query("Analytics.inventory.projects", (q) =>
          q
            .select({ id: schema.project.id, orgId: schema.project.orgId })
            .from(schema.project)
            .leftJoin(schema.usageInventory, eq(schema.project.id, schema.usageInventory.projectId))
            .where(
              or(
                isNull(schema.usageInventory.completedAt),
                lt(schema.usageInventory.completedAt, now - 86_400_000),
              ),
            )
            .orderBy(
              asc(schema.usageInventory.completedAt),
              asc(schema.usageInventory.startedAt),
              asc(schema.project.id),
            )
            .limit(1),
        );
        for (const project of projects) {
          yield* db.query("Analytics.inventory.start", (q) =>
            q
              .insert(schema.usageInventory)
              .values({ projectId: project.id, orgId: project.orgId, startedAt: now })
              .onConflictDoUpdate({
                target: schema.usageInventory.projectId,
                set: { cursor: null, bytes: 0, startedAt: now, completedAt: null },
                where: lt(schema.usageInventory.completedAt, now - 86_400_000),
              }),
          );
          const [state] = yield* db.query("Analytics.inventory.state", (q) =>
            q
              .select()
              .from(schema.usageInventory)
              .where(eq(schema.usageInventory.projectId, project.id)),
          );
          if (!state || state.completedAt !== null) continue;
          const prefix = `${project.orgId}/${project.id}/`;
          const page = yield* inventory.list(prefix, state.cursor ?? undefined);
          if (page.objects.length > 10)
            return yield* new AnalyticsError({ cause: "Inventory page exceeded limit" });
          for (const object of page.objects) {
            const hash = object.key.slice(prefix.length);
            if (!object.key.startsWith(prefix) || !/^[a-fA-F0-9]+$/.test(hash)) continue;
            yield* accounting.record(
              { orgId: project.orgId, projectId: project.id },
              hash,
              object.size,
            );
          }
          if (page.cursor) {
            yield* db.query("Analytics.inventory.cursor", (q) =>
              q
                .update(schema.usageInventory)
                .set({ cursor: page.cursor })
                .where(
                  and(
                    eq(schema.usageInventory.projectId, project.id),
                    eq(schema.usageInventory.startedAt, state.startedAt),
                    state.cursor === null
                      ? isNull(schema.usageInventory.cursor)
                      : eq(schema.usageInventory.cursor, state.cursor),
                  ),
                ),
            );
          } else {
            // Repair native R2 expiry and failed writes. Live observations since the scan started survive.
            yield* db.batch((q) => [
              q
                .delete(schema.artifactUsage)
                .where(
                  and(
                    eq(schema.artifactUsage.orgId, project.orgId),
                    eq(schema.artifactUsage.projectId, project.id),
                    lt(schema.artifactUsage.observedAt, state.startedAt),
                  ),
                ),
              q
                .insert(schema.projectUsage)
                .values({ orgId: project.orgId, projectId: project.id, bytes: 0 })
                .onConflictDoNothing(),
              q
                .update(schema.projectUsage)
                .set({
                  bytes: sql`coalesce((select sum(bytes) from artifact_usage where org_id = ${project.orgId} and project_id = ${project.id}), 0)`,
                  reconciledAt: now,
                })
                .where(
                  and(
                    eq(schema.projectUsage.orgId, project.orgId),
                    eq(schema.projectUsage.projectId, project.id),
                  ),
                ),
              q
                .update(schema.usageInventory)
                .set({ completedAt: now, cursor: null })
                .where(
                  and(
                    eq(schema.usageInventory.projectId, project.id),
                    eq(schema.usageInventory.startedAt, state.startedAt),
                  ),
                ),
            ]);
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof AnalyticsError ? cause : new AnalyticsError({ cause }),
        ),
      ),
    };
  }),
);
