import { AuthorizationCeilings } from "@repo/authz";
import { AuditLog } from "@repo/audit";
import { Database, InstanceSettingsRepo, schema } from "@repo/db";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { ProjectLimits } from "./projects.ts";

export class ProjectRetentionRules extends Context.Service<
  ProjectRetentionRules,
  {
    readonly sync: (
      projectId: string,
      prefix: string,
      days: number,
    ) => Effect.Effect<boolean, unknown>;
  }
>()("@repo/projects/ProjectRetentionRules") {}

export const artifactPrefix = (orgId: string, projectId: string) => `${orgId}/${projectId}/`;

/** The host owns R2 and revocation adapters; jobs retain no runtime binding. */
export class ProjectStorage extends Context.Service<
  ProjectStorage,
  {
    readonly list: (
      prefix: string,
      cursor?: string,
    ) => Effect.Effect<
      {
        readonly objects: readonly { readonly key: string; readonly uploaded: Date }[];
        readonly cursor?: string;
      },
      unknown
    >;
    readonly delete: (keys: readonly string[]) => Effect.Effect<void, unknown>;
    readonly revoke: (projectId: string) => Effect.Effect<void, unknown>;
  }
>()("@repo/projects/ProjectStorage") {}

const maintenance = Effect.gen(function* () {
  const database = yield* Database;
  const storage = yield* ProjectStorage;
  const audit = yield* AuditLog;
  const settings = yield* InstanceSettingsRepo;
  const limits = yield* ProjectLimits;
  const ceilings = yield* AuthorizationCeilings;
  const rules = yield* Effect.serviceOption(ProjectRetentionRules);

  return {
    /** One deletion page and one retention page per tick, independent of project count. */
    tick: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const [job] = yield* database.query("Projects.pendingDeletion", (db) =>
        db
          .select()
          .from(schema.projectDeletion)
          .where(isNull(schema.projectDeletion.completedAt))
          .orderBy(asc(schema.projectDeletion.requestedAt))
          .limit(1),
      );
      if (job) {
        // Retrying after an interrupted tick may bump twice; both epochs revoke prior tokens.
        yield* storage.revoke(job.projectId);
        const page = yield* storage.list(
          artifactPrefix(job.orgId, job.projectId),
          job.cursor ?? undefined,
        );
        if (page.objects.length > 0)
          yield* storage.delete(page.objects.map((object) => object.key));
        else if (page.cursor === undefined) {
          yield* audit.commit(
            {
              scope: "org",
              orgId: job.orgId,
              projectId: job.projectId,
              actor: { type: "system", id: "project-maintenance", display: "Project maintenance" },
              action: "project.deleted",
              target: { type: "project", id: job.projectId },
              outcome: "allow",
              ip: "",
              userAgent: "",
              requestId: crypto.randomUUID(),
              metadata: {},
            },
            (db) => [
              db
                .delete(schema.projectGrant)
                .where(eq(schema.projectGrant.projectId, job.projectId)),
              db.delete(schema.trustPolicy).where(eq(schema.trustPolicy.projectId, job.projectId)),
              db.delete(schema.rollup).where(eq(schema.rollup.projectId, job.projectId)),
              db
                .delete(schema.projectRetention)
                .where(eq(schema.projectRetention.projectId, job.projectId)),
              db.delete(schema.quotaConfig).where(eq(schema.quotaConfig.projectId, job.projectId)),
              db
                .delete(schema.quotaReservation)
                .where(eq(schema.quotaReservation.projectId, job.projectId)),
              db.delete(schema.quotaUsage).where(eq(schema.quotaUsage.projectId, job.projectId)),
              db
                .delete(schema.quotaEviction)
                .where(eq(schema.quotaEviction.projectId, job.projectId)),
              db
                .delete(schema.artifactSigningKey)
                .where(eq(schema.artifactSigningKey.projectId, job.projectId)),
              db
                .delete(schema.artifactSigningSettings)
                .where(eq(schema.artifactSigningSettings.projectId, job.projectId)),
              db
                .delete(schema.anomalyConfig)
                .where(eq(schema.anomalyConfig.projectId, job.projectId)),
              db
                .delete(schema.anomalyState)
                .where(eq(schema.anomalyState.projectId, job.projectId)),
              db
                .delete(schema.anomalyIdentity)
                .where(eq(schema.anomalyIdentity.projectId, job.projectId)),
              db.delete(schema.anomalyHour).where(eq(schema.anomalyHour.projectId, job.projectId)),
              db.delete(schema.project).where(eq(schema.project.id, job.projectId)),
              db
                .update(schema.projectDeletion)
                .set({ completedAt: now })
                .where(eq(schema.projectDeletion.projectId, job.projectId)),
            ],
          );
        }
        if (page.cursor !== undefined)
          yield* database.query("Projects.deletionProgress", (db) =>
            db
              .update(schema.projectDeletion)
              .set({ cursor: page.cursor })
              .where(eq(schema.projectDeletion.projectId, job.projectId)),
          );
        else if (page.objects.length > 0 && job.cursor !== null)
          yield* database.query("Projects.deletionRestart", (db) =>
            db
              .update(schema.projectDeletion)
              .set({ cursor: null })
              .where(eq(schema.projectDeletion.projectId, job.projectId)),
          );
      }

      const [candidate] = yield* database.query("Projects.retentionCandidate", (db) =>
        db
          .select({
            project: schema.project,
            state: schema.projectRetention,
          })
          .from(schema.project)
          .leftJoin(
            schema.projectRetention,
            eq(schema.projectRetention.projectId, schema.project.id),
          )
          .leftJoin(schema.projectDeletion, eq(schema.projectDeletion.projectId, schema.project.id))
          .where(isNull(schema.projectDeletion.projectId))
          .orderBy(sql`coalesce(${schema.projectRetention.scannedAt}, 0)`, schema.project.id)
          .limit(1),
      );
      if (!candidate) return;
      const project = candidate.project;
      const policy = yield* settings.policy(project.orgId, ceilings);
      const days = Math.min(
        project.retentionDays ?? limits.retentionDays,
        limits.retentionDays,
        policy.retentionDays,
      );
      if (rules._tag === "Some")
        yield* rules.value
          .sync(project.id, artifactPrefix(project.orgId, project.id), days)
          .pipe(
            Effect.catch((error) =>
              Effect.logError("Native retention unavailable; using sweeper", error),
            ),
          );
      const page = yield* storage.list(
        artifactPrefix(project.orgId, project.id),
        candidate.state?.cursor ?? undefined,
      );
      const expired = page.objects.filter(
        (object) => object.uploaded.getTime() <= now - days * 86_400_000,
      );
      if (expired.length) yield* storage.delete(expired.map((object) => object.key));
      // Round-robin even when a prefix spans many pages; a failed page never advances its cursor.
      yield* database.query("Projects.retentionProgress", (db) =>
        db
          .insert(schema.projectRetention)
          .values({ projectId: project.id, cursor: page.cursor ?? null, scannedAt: now })
          .onConflictDoUpdate({
            target: schema.projectRetention.projectId,
            set: { cursor: page.cursor ?? null, scannedAt: now },
          }),
      );
    }),
  };
});

export class ProjectMaintenance extends Context.Service<
  ProjectMaintenance,
  Effect.Success<typeof maintenance>
>()("@repo/projects/ProjectMaintenance") {}
export const ProjectMaintenanceLive = Layer.effect(ProjectMaintenance, maintenance);
