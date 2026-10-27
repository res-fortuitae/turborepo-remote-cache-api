import { Database, schema, InstanceSettingsRepo } from "@repo/db";
import { AuditLog, type AuditInput } from "@repo/audit";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { PurgeInventory } from "./incident.ts";
import { ArtifactPurger } from "./purge.ts";

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {}) {}
export class QuotaUnavailable extends Schema.TaggedError<QuotaUnavailable>()(
  "QuotaUnavailable",
  {},
) {}
export class QuotaDefaults extends Context.Service<
  QuotaDefaults,
  { readonly storageBytes: (org: string) => Effect.Effect<number, unknown> }
>()("@repo/artifacts/QuotaDefaults") {}
export interface QuotaScope {
  readonly orgId: string;
  readonly projectId: string;
}
export interface QuotaSettings {
  readonly storageBytes: number | null;
  readonly bandwidthBytes: number | null;
  readonly requests: number | null;
  readonly onQuotaExceeded: "reject" | "evict-oldest";
}
const dayOf = (now: number) => Math.floor(now / 86400000) * 86400000;
const base: QuotaSettings = {
  storageBytes: null,
  bandwidthBytes: null,
  requests: null,
  onQuotaExceeded: "reject",
};
const systemEvent = (scope: QuotaScope, action: string): AuditInput => ({
  scope: "org",
  ...scope,
  actor: { type: "system", id: "quota", display: "Quota maintenance" },
  action,
  target: { type: "project", id: scope.projectId },
  outcome: "allow",
  ip: "",
  userAgent: "",
  requestId: crypto.randomUUID(),
  metadata: {},
});

const make = Effect.gen(function* () {
  const db = yield* Database,
    defaults = yield* QuotaDefaults,
    audit = yield* AuditLog;
  const config = (scope: QuotaScope) =>
    Effect.gen(function* () {
      const rows = yield* db.query("Quota.config", (q) =>
        q.select().from(schema.quotaConfig).where(eq(schema.quotaConfig.orgId, scope.orgId)),
      );
      const fallback = yield* defaults.storageBytes(scope.orgId);
      const org = rows.find((row) => row.projectId === "") ?? { ...base, storageBytes: fallback };
      const project = rows.find((row) => row.projectId === scope.projectId) ?? base;
      return {
        ceilingBytes: fallback,
        org: { ...org, storageBytes: Math.min(org.storageBytes ?? fallback, fallback) },
        project: { ...project, storageBytes: Math.min(project.storageBytes ?? fallback, fallback) },
      };
    });
  const status = (scope: QuotaScope) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis,
        settings = yield* config(scope);
      const [storage, usage, reservations, jobs] = yield* Effect.all([
        db.query("Quota.storage", (q) =>
          q.select().from(schema.projectUsage).where(eq(schema.projectUsage.orgId, scope.orgId)),
        ),
        db.query("Quota.usage", (q) =>
          q
            .select()
            .from(schema.quotaUsage)
            .where(
              and(eq(schema.quotaUsage.orgId, scope.orgId), eq(schema.quotaUsage.day, dayOf(now))),
            ),
        ),
        db.query("Quota.reserved", (q) =>
          q
            .select()
            .from(schema.quotaReservation)
            .where(
              and(
                eq(schema.quotaReservation.orgId, scope.orgId),
                gt(schema.quotaReservation.expiresAt, now),
              ),
            ),
        ),
        db.query("Quota.job", (q) =>
          q
            .select()
            .from(schema.quotaEviction)
            .where(eq(schema.quotaEviction.projectId, scope.projectId)),
        ),
      ]);
      const measure = (projectOnly: boolean) => ({
        storageBytes: storage
          .filter((row) => !projectOnly || row.projectId === scope.projectId)
          .reduce((sum, row) => sum + row.bytes, 0),
        bandwidthBytes: usage
          .filter((row) => !projectOnly || row.projectId === scope.projectId)
          .reduce((sum, row) => sum + row.bandwidthBytes, 0),
        requests: usage
          .filter((row) => !projectOnly || row.projectId === scope.projectId)
          .reduce((sum, row) => sum + row.requests, 0),
        reservedRequests: reservations.filter(
          (row) => !projectOnly || row.projectId === scope.projectId,
        ).length,
        reservedTransferBytes: reservations
          .filter((row) => !projectOnly || row.projectId === scope.projectId)
          .reduce((sum, row) => sum + row.transferBytes, 0),
        reservedBytes: reservations
          .filter((row) => !projectOnly || row.projectId === scope.projectId)
          .reduce((sum, row) => sum + row.bytes, 0),
      });
      const org = measure(false),
        project = measure(true);
      const exceeded = (usage: typeof org, limits: QuotaSettings) =>
        usage.storageBytes + usage.reservedBytes >= limits.storageBytes! ||
        (limits.bandwidthBytes !== null &&
          usage.bandwidthBytes + usage.reservedTransferBytes >= limits.bandwidthBytes) ||
        (limits.requests !== null && usage.requests + usage.reservedRequests >= limits.requests);
      return {
        org: { usage: org, limits: settings.org },
        project: { usage: project, limits: settings.project },
        overLimit:
          exceeded(org, settings.org) ||
          exceeded(project, settings.project) ||
          jobs.some((job) => job.state !== "complete"),
        eviction: jobs[0]
          ? {
              id: jobs[0].id,
              state: jobs[0].state,
              removed: jobs[0].removed,
              removedBytes: jobs[0].removedBytes,
            }
          : null,
        day: new Date(dayOf(now)).toISOString(),
      };
    });
  const schedule = (scope: QuotaScope) =>
    Effect.gen(function* () {
      const settings = yield* config(scope);
      if (settings.project.onQuotaExceeded !== "evict-oldest") return;
      const now = yield* Clock.currentTimeMillis;
      yield* db.query("Quota.schedule", (q) =>
        q
          .insert(schema.quotaEviction)
          .values({
            ...scope,
            id: crypto.randomUUID(),
            state: "scanning",
            startedAt: now,
            candidates: [],
          })
          .onConflictDoUpdate({
            target: schema.quotaEviction.projectId,
            set: {
              id: crypto.randomUUID(),
              state: "scanning",
              startedAt: now,
              candidates: [],
              cursor: null,
              removed: 0,
              removedBytes: 0,
            },
            where: eq(schema.quotaEviction.state, "complete"),
          }),
      );
    });
  return {
    config: (scope: QuotaScope) =>
      config(scope).pipe(Effect.mapError(() => new QuotaUnavailable())),
    status: (scope: QuotaScope) =>
      status(scope).pipe(Effect.mapError(() => new QuotaUnavailable())),
    configure: (scope: QuotaScope, settings: QuotaSettings, event: AuditInput) =>
      audit
        .commit({ ...event, action: "quota.configure", metadata: { ...settings } }, (q) => [
          q
            .insert(schema.quotaConfig)
            .values({ ...scope, ...settings })
            .onConflictDoUpdate({
              target: [schema.quotaConfig.orgId, schema.quotaConfig.projectId],
              set: settings,
            }),
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(() => new QuotaUnavailable()),
        ),
    reserve: (scope: QuotaScope, hash: string, size: number, lifetime = 3600000) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(size) || size < 0) return yield* new QuotaExceeded();
        const now = yield* Clock.currentTimeMillis,
          settings = yield* config(scope),
          id = crypto.randomUUID();
        const [existing] = yield* db.query("Quota.oldSize", (q) =>
          q
            .select()
            .from(schema.artifactUsage)
            .where(
              and(
                eq(schema.artifactUsage.orgId, scope.orgId),
                eq(schema.artifactUsage.projectId, scope.projectId),
                eq(schema.artifactUsage.hash, hash),
              ),
            ),
        );
        const delta = Math.max(0, size - (existing?.bytes ?? 0));
        const deltaSql = sql`max(0, ${size} - coalesce((select bytes from artifact_usage where org_id = ${scope.orgId} and project_id = ${scope.projectId} and hash = ${hash}), 0))`;
        const accepted = yield* db.batch((q) => [
          q.delete(schema.quotaReservation).where(lt(schema.quotaReservation.expiresAt, now)),
          q
            .insert(schema.quotaReservation)
            .select(
              q
                .select({
                  id: sql<string>`${id}`.as("id"),
                  orgId: sql<string>`${scope.orgId}`.as("org_id"),
                  projectId: sql<string>`${scope.projectId}`.as("project_id"),
                  hash: sql<string>`${hash}`.as("hash"),
                  bytes: sql<number>`${deltaSql}`.as("bytes"),
                  transferBytes: sql<number>`${size}`.as("transfer_bytes"),
                  expiresAt: sql<number>`${now + lifetime}`.as("expires_at"),
                })
                .from(schema.project)
                .where(
                  and(
                    eq(schema.project.id, scope.projectId),
                    eq(schema.project.orgId, scope.orgId),
                    sql`not exists (select 1 from quota_eviction where project_id = ${scope.projectId} and state != 'complete')`,
                    sql`not exists (select 1 from quota_reservation where project_id = ${scope.projectId} and hash = ${hash})`,
                    sql`coalesce((select bytes from project_usage where org_id = ${scope.orgId} and project_id = ${scope.projectId}), 0) + coalesce((select sum(bytes) from quota_reservation where project_id = ${scope.projectId}), 0) + ${deltaSql} <= ${settings.project.storageBytes}`,
                    sql`coalesce((select sum(bytes) from project_usage where org_id = ${scope.orgId}), 0) + coalesce((select sum(bytes) from quota_reservation where org_id = ${scope.orgId}), 0) + ${deltaSql} <= ${settings.org.storageBytes}`,
                    sql`coalesce((select bytes from project_usage where project_id = ${scope.projectId}), 0) < ${settings.project.storageBytes}`,
                    sql`coalesce((select sum(bytes) from project_usage where org_id = ${scope.orgId}), 0) < ${settings.org.storageBytes}`,
                    ...([settings.org, settings.project] as const).flatMap((limit, index) => {
                      const project =
                        index === 1 ? sql`and project_id = ${scope.projectId}` : sql``;
                      return [
                        limit.bandwidthBytes === null
                          ? undefined
                          : sql`coalesce((select sum(bandwidth_bytes) from quota_usage where org_id = ${scope.orgId} and day = ${dayOf(now)} ${project}), 0) + coalesce((select sum(transfer_bytes) from quota_reservation where org_id = ${scope.orgId} ${project}), 0) + ${size} <= ${limit.bandwidthBytes}`,
                        limit.requests === null
                          ? undefined
                          : sql`coalesce((select sum(requests) from quota_usage where org_id = ${scope.orgId} and day = ${dayOf(now)} ${project}), 0) + (select count(*) from quota_reservation where org_id = ${scope.orgId} ${project}) < ${limit.requests}`,
                      ];
                    }),
                  ),
                ),
            )
            .returning({ id: schema.quotaReservation.id }),
        ]);
        if (!accepted[1]?.length) {
          const current = yield* status(scope);
          if (
            current.org.usage.storageBytes + delta >= current.org.limits.storageBytes ||
            current.project.usage.storageBytes + delta >= current.project.limits.storageBytes
          )
            yield* schedule(scope);
          return yield* new QuotaExceeded();
        }
        return id;
      }).pipe(
        Effect.mapError((error) =>
          error instanceof QuotaExceeded ? error : new QuotaUnavailable(),
        ),
      ),
    release: (id: string) =>
      db
        .query("Quota.release", (q) =>
          q.delete(schema.quotaReservation).where(eq(schema.quotaReservation.id, id)),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError(() => new QuotaUnavailable()),
        ),
    finish: (id: string, actualBytes: number) =>
      Effect.gen(function* () {
        const [reservation] = yield* db.query("Quota.finishReservation", (q) =>
          q.select().from(schema.quotaReservation).where(eq(schema.quotaReservation.id, id)),
        );
        if (!reservation) return yield* new QuotaUnavailable();
        const { orgId, projectId, hash } = reservation;
        if (
          actualBytes > reservation.transferBytes ||
          !Number.isSafeInteger(actualBytes) ||
          actualBytes < 0
        )
          return yield* new QuotaUnavailable();
        const day = dayOf(yield* Clock.currentTimeMillis);
        // Ledger and reservation release share a D1 transaction. Accounting observers are idempotent.
        yield* db.batch((q) => [
          q
            .insert(schema.projectUsage)
            .values({ orgId, projectId, bytes: 0 })
            .onConflictDoNothing(),
          q
            .update(schema.projectUsage)
            .set({
              bytes: sql`max(0, bytes + ${actualBytes} - coalesce((select bytes from artifact_usage where project_id = ${projectId} and hash = ${hash}), 0))`,
            })
            .where(
              and(
                eq(schema.projectUsage.orgId, orgId),
                eq(schema.projectUsage.projectId, projectId),
              ),
            ),
          q
            .insert(schema.artifactUsage)
            .values({ orgId, projectId, hash, bytes: actualBytes, observedAt: Date.now() })
            .onConflictDoUpdate({
              target: [
                schema.artifactUsage.orgId,
                schema.artifactUsage.projectId,
                schema.artifactUsage.hash,
              ],
              set: { bytes: actualBytes, observedAt: Date.now() },
            }),
          q
            .insert(schema.quotaUsage)
            .values({ orgId, projectId, day, requests: 1, bandwidthBytes: actualBytes })
            .onConflictDoUpdate({
              target: [schema.quotaUsage.orgId, schema.quotaUsage.projectId, schema.quotaUsage.day],
              set: {
                requests: sql`${schema.quotaUsage.requests} + 1`,
                bandwidthBytes: sql`${schema.quotaUsage.bandwidthBytes} + ${actualBytes}`,
              },
            }),
          q.delete(schema.quotaReservation).where(eq(schema.quotaReservation.id, id)),
        ]);
      }).pipe(Effect.mapError(() => new QuotaUnavailable())),
    observe: (scope: QuotaScope, bytes: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis,
          day = dayOf(now);
        yield* db.query("Quota.observe", (q) =>
          q
            .insert(schema.quotaUsage)
            .values({ ...scope, day, requests: 1, bandwidthBytes: Math.max(0, bytes) })
            .onConflictDoUpdate({
              target: [schema.quotaUsage.orgId, schema.quotaUsage.projectId, schema.quotaUsage.day],
              set: {
                requests: sql`${schema.quotaUsage.requests} + 1`,
                bandwidthBytes: sql`${schema.quotaUsage.bandwidthBytes} + ${Math.max(0, bytes)}`,
              },
            }),
        );
      }).pipe(Effect.mapError(() => new QuotaUnavailable())),
    notify: (scope: QuotaScope) =>
      Effect.gen(function* () {
        const current = yield* status(scope),
          now = yield* Clock.currentTimeMillis;
        const members = yield* db.query("Quota.admins", (q) =>
          q.select().from(schema.member).where(eq(schema.member.organizationId, scope.orgId)),
        );
        for (const [kind, value] of [
          ["org", current.org],
          ["project", current.project],
        ] as const)
          for (const metric of ["storageBytes", "bandwidthBytes", "requests"] as const) {
            const limit = value.limits[metric];
            if (!limit) continue;
            const threshold =
              value.usage[metric] >= limit ? 100 : value.usage[metric] >= limit * 0.8 ? 80 : 0;
            if (!threshold) continue;
            for (const member of members.filter((member) =>
              member.role.split(",").some((role) => ["owner", "admin"].includes(role.trim())),
            ))
              yield* db.query("Quota.notify", (q) =>
                q
                  .insert(schema.notification)
                  .values({
                    id: `quota:${dayOf(now)}:${scope.orgId}:${kind === "project" ? scope.projectId : "org"}:${metric}:${threshold}:${member.userId}`,
                    userId: member.userId,
                    kind: "quota",
                    detail: `${kind} ${kind === "project" ? scope.projectId : scope.orgId}: ${metric} reached ${threshold}% (${value.usage[metric]} / ${limit}).`,
                    createdAt: now,
                  })
                  .onConflictDoNothing(),
              );
          }
      }).pipe(Effect.mapError(() => new QuotaUnavailable())),
  };
});
export class Quotas extends Context.Service<Quotas, Effect.Success<typeof make>>()(
  "@repo/artifacts/Quotas",
) {}
export const QuotasLive = Layer.effect(Quotas, make);

export class QuotaEviction extends Context.Service<
  QuotaEviction,
  { readonly tick: Effect.Effect<void, QuotaUnavailable> }
>()("@repo/artifacts/QuotaEviction") {}
export const QuotaEvictionLive = Layer.effect(
  QuotaEviction,
  Effect.gen(function* () {
    const db = yield* Database,
      quotas = yield* Quotas,
      inventory = yield* PurgeInventory,
      purger = yield* ArtifactPurger,
      audit = yield* AuditLog;
    return {
      tick: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [job] = yield* db.query("Quota.evictionNext", (q) =>
          q
            .select()
            .from(schema.quotaEviction)
            .where(
              and(
                ne(schema.quotaEviction.state, "complete"),
                lt(schema.quotaEviction.leaseUntil, now),
              ),
            )
            .orderBy(schema.quotaEviction.startedAt)
            .limit(1),
        );
        if (!job) return;
        const claimed = yield* db.query("Quota.evictionClaim", (q) =>
          q
            .update(schema.quotaEviction)
            .set({ leaseUntil: now + 120000 })
            .where(
              and(
                eq(schema.quotaEviction.projectId, job.projectId),
                lt(schema.quotaEviction.leaseUntil, now),
              ),
            )
            .returning({ id: schema.quotaEviction.id }),
        );
        if (!claimed.length) return;
        const run = Effect.gen(function* () {
          const scope = { orgId: job.orgId, projectId: job.projectId };
          const reservations = yield* db.query("Quota.evictionInflight", (q) =>
            q
              .select()
              .from(schema.quotaReservation)
              .where(
                and(
                  eq(schema.quotaReservation.projectId, job.projectId),
                  gt(schema.quotaReservation.expiresAt, now),
                ),
              )
              .limit(1),
          );
          if (reservations.length) return;
          const current = yield* quotas.status(scope);
          const done =
            current.project.usage.storageBytes < current.project.limits.storageBytes * 0.9 &&
            current.org.usage.storageBytes < current.org.limits.storageBytes * 0.9;
          const complete = (reason: string) =>
            audit.commit(
              {
                ...systemEvent(scope, "quota.eviction.complete"),
                metadata: {
                  jobId: job.id,
                  removed: job.removed,
                  removedBytes: job.removedBytes,
                  reason,
                },
              },
              (q) => [
                ...(reason === "no_more_artifacts"
                  ? [
                      q
                        .delete(schema.artifactUsage)
                        .where(eq(schema.artifactUsage.projectId, job.projectId)),
                      q
                        .update(schema.projectUsage)
                        .set({ bytes: 0 })
                        .where(eq(schema.projectUsage.projectId, job.projectId)),
                    ]
                  : []),
                q
                  .update(schema.quotaEviction)
                  .set({ state: "complete", candidates: [], cursor: null })
                  .where(eq(schema.quotaEviction.projectId, job.projectId)),
                ...[
                  ["evictions", job.removed],
                  ["evictedBytes", job.removedBytes],
                ].map(([metric, value]) =>
                  q
                    .insert(schema.rollup)
                    .values({
                      ...scope,
                      bucketStart: Math.floor(now / 3600000) * 3600000,
                      metric: String(metric),
                      value: Number(value),
                    })
                    .onConflictDoUpdate({
                      target: [
                        schema.rollup.orgId,
                        schema.rollup.projectId,
                        schema.rollup.bucketStart,
                        schema.rollup.metric,
                      ],
                      set: { value: sql`${schema.rollup.value} + ${Number(value)}` },
                    }),
                ),
              ],
            );
          if (done) {
            yield* complete("below_90_percent");
            return;
          }
          const prefix = `${job.orgId}/${job.projectId}/`;
          if (job.state === "scanning") {
            const page = yield* inventory.list(prefix, job.cursor ?? undefined);
            const candidates = [
              ...job.candidates,
              ...page.objects
                .filter(
                  (object) =>
                    object.key.startsWith(prefix) &&
                    /^[a-fA-F0-9]+$/.test(object.key.slice(prefix.length)),
                )
                .map((object) => ({
                  key: object.key,
                  etag: object.etag,
                  size: object.size,
                  uploaded: Number.isFinite(Date.parse(object.metadata.uploadedAt ?? ""))
                    ? Date.parse(object.metadata.uploadedAt!)
                    : object.uploaded,
                })),
            ]
              .sort((a, b) => a.uploaded - b.uploaded || a.key.localeCompare(b.key))
              .slice(0, 100);
            if (!page.cursor && candidates.length === 0) {
              yield* complete("no_more_artifacts");
              return;
            }
            yield* db.query("Quota.evictionScan", (q) =>
              q
                .update(schema.quotaEviction)
                .set({
                  candidates,
                  cursor: page.cursor ?? null,
                  state: page.cursor ? "scanning" : "deleting",
                })
                .where(eq(schema.quotaEviction.projectId, job.projectId)),
            );
            return;
          }
          let removed = job.removed,
            removedBytes = job.removedBytes,
            processed = 0;
          for (const candidate of job.candidates.slice(0, 25)) {
            const object = yield* inventory.head(candidate.key);
            if (object && object.etag !== candidate.etag) {
              processed++;
              continue;
            }
            yield* inventory.remove([candidate.key]);
            if (object) {
              removed++;
              removedBytes += object.size;
            }
            processed++;
            yield* purger.invalidate(job.projectId);
            const status = yield* quotas.status(scope);
            if (
              status.project.usage.storageBytes < status.project.limits.storageBytes * 0.9 &&
              status.org.usage.storageBytes < status.org.limits.storageBytes * 0.9
            )
              break;
          }
          const candidates = job.candidates.slice(processed);
          yield* db.query("Quota.evictionCheckpoint", (q) =>
            q
              .update(schema.quotaEviction)
              .set({
                removed,
                removedBytes,
                candidates,
                state: candidates.length ? "deleting" : "scanning",
                cursor: null,
              })
              .where(eq(schema.quotaEviction.projectId, job.projectId)),
          );
        });
        yield* run.pipe(
          Effect.ensuring(
            db
              .query("Quota.evictionRelease", (q) =>
                q
                  .update(schema.quotaEviction)
                  .set({ leaseUntil: 0 })
                  .where(eq(schema.quotaEviction.projectId, job.projectId)),
              )
              .pipe(Effect.orDie),
          ),
        );
      }).pipe(
        Effect.asVoid,
        Effect.mapError(() => new QuotaUnavailable()),
      ),
    };
  }),
);
