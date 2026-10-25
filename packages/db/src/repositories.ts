import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "./database.ts";
import {
  member,
  team,
  teamMember,
  oidcJti,
  project,
  projectGrant,
  trustPolicy,
} from "./schema/index.ts";

export type Project = typeof project.$inferSelect;

export type NewProject = typeof project.$inferInsert;

export type Grant = typeof projectGrant.$inferSelect;

export type NewGrant = typeof projectGrant.$inferInsert;

export type TrustPolicy = typeof trustPolicy.$inferSelect;

export type NewTrustPolicy = typeof trustPolicy.$inferInsert;

const projectRepo = Effect.gen(function* () {
  const database = yield* Database;

  return {
    /** Internal routing lookup only. The caller must authorize the returned org. */
    locate: (id: string) =>
      database.query("ProjectRepo.locate", (db) =>
        db.select().from(project).where(eq(project.id, id)).get(),
      ),
    page: (orgId: string, limit: number, cursor?: string) =>
      database.query("ProjectRepo.page", (db) =>
        db
          .select()
          .from(project)
          .where(
            and(
              eq(project.orgId, orgId),
              cursor === undefined ? undefined : gt(project.id, cursor),
            ),
          )
          .orderBy(project.id)
          .limit(limit),
      ),
    find: (orgId: string, id: string) =>
      database.query("ProjectRepo.find", (db) =>
        db
          .select()
          .from(project)
          .where(and(eq(project.orgId, orgId), eq(project.id, id)))
          .get(),
      ),
    list: (orgId: string) =>
      database.query("ProjectRepo.list", (db) =>
        db.select().from(project).where(eq(project.orgId, orgId)).orderBy(project.id),
      ),
    create: (value: NewProject) =>
      database.query("ProjectRepo.create", (db) =>
        db.insert(project).values(value).returning().get(),
      ),
  };
});

export class ProjectRepo extends Context.Service<ProjectRepo, Effect.Success<typeof projectRepo>>()(
  "@repo/db/ProjectRepo",
) {}

export const ProjectRepoLive = Layer.effect(ProjectRepo, projectRepo);

const grantRepo = Effect.gen(function* () {
  const database = yield* Database;

  return {
    resolve: (orgId: string, projectId: string, userId: string) =>
      Effect.gen(function* () {
        const [membership] = yield* database.query("GrantRepo.membership", (db) =>
          db
            .select()
            .from(member)
            .where(and(eq(member.organizationId, orgId), eq(member.userId, userId))),
        );

        if (!membership) return null;

        const [owned] = yield* database.query("GrantRepo.project", (db) =>
          db
            .select()
            .from(project)
            .where(and(eq(project.orgId, orgId), eq(project.id, projectId))),
        );

        if (!owned) return null;

        if (membership.role.split(",").some((role) => ["owner", "admin"].includes(role.trim())))
          return "project:admin" as const;

        const roles = yield* database.query("GrantRepo.resolve", (db) =>
          db
            .select({ role: projectGrant.role })
            .from(projectGrant)
            .where(
              and(
                eq(projectGrant.projectId, projectId),
                or(
                  and(eq(projectGrant.principalType, "user"), eq(projectGrant.principalId, userId)),
                  and(
                    eq(projectGrant.principalType, "team"),
                    inArray(
                      projectGrant.principalId,
                      db
                        .select({ id: team.id })
                        .from(team)
                        .innerJoin(teamMember, eq(teamMember.teamId, team.id))
                        .where(and(eq(team.organizationId, orgId), eq(teamMember.userId, userId))),
                    ),
                  ),
                ),
              ),
            ),
        );

        const rank = { "cache:read": 1, "cache:write": 2, "project:admin": 3 };

        return roles.reduce<Grant["role"] | null>(
          (best, row) => (best === null || rank[row.role] > rank[best] ? row.role : best),
          null,
        );
      }),
    list: (projectId: string) =>
      database.query("GrantRepo.list", (db) =>
        db
          .select()
          .from(projectGrant)
          .where(eq(projectGrant.projectId, projectId))
          .orderBy(projectGrant.principalType, projectGrant.principalId),
      ),
    create: (value: NewGrant) =>
      database.query("GrantRepo.create", (db) =>
        db.insert(projectGrant).values(value).returning().get(),
      ),
    remove: (projectId: string, principalType: Grant["principalType"], principalId: string) =>
      database.query("GrantRepo.remove", (db) =>
        db
          .delete(projectGrant)
          .where(
            and(
              eq(projectGrant.projectId, projectId),
              eq(projectGrant.principalType, principalType),
              eq(projectGrant.principalId, principalId),
            ),
          )
          .returning(),
      ),
  };
});

export class GrantRepo extends Context.Service<GrantRepo, Effect.Success<typeof grantRepo>>()(
  "@repo/db/GrantRepo",
) {}

export const GrantRepoLive = Layer.effect(GrantRepo, grantRepo);

const trustPolicyRepo = Effect.gen(function* () {
  const database = yield* Database;

  return {
    find: (projectId: string, id: string) =>
      database.query("TrustPolicyRepo.find", (db) =>
        db
          .select()
          .from(trustPolicy)
          .where(and(eq(trustPolicy.projectId, projectId), eq(trustPolicy.id, id)))
          .get(),
      ),
    list: (projectId: string) =>
      database.query("TrustPolicyRepo.list", (db) =>
        db
          .select()
          .from(trustPolicy)
          .where(eq(trustPolicy.projectId, projectId))
          .orderBy(trustPolicy.id),
      ),
    create: (value: NewTrustPolicy) =>
      database.query("TrustPolicyRepo.create", (db) =>
        db.insert(trustPolicy).values(value).returning().get(),
      ),
  };
});

export class TrustPolicyRepo extends Context.Service<
  TrustPolicyRepo,
  Effect.Success<typeof trustPolicyRepo>
>()("@repo/db/TrustPolicyRepo") {}

export const TrustPolicyRepoLive = Layer.effect(TrustPolicyRepo, trustPolicyRepo);

const replayGuard = Effect.gen(function* () {
  const database = yield* Database;

  return {
    /**
     * Records a token id once. Returns false if it was already used and has
     * not expired; one statement, so concurrent claims cannot both win.
     */
    claim: (issuer: string, jti: string, expiresAt: number, now: number) =>
      database
        .query("ReplayGuard.claim", (db) =>
          db
            .insert(oidcJti)
            .values({ issuer, jti, expiresAt })
            .onConflictDoUpdate({
              target: [oidcJti.issuer, oidcJti.jti],
              set: { expiresAt: sql`excluded.expires_at` },
              setWhere: lte(oidcJti.expiresAt, now),
            })
            .returning({ jti: oidcJti.jti }),
        )
        .pipe(Effect.map((rows) => rows.length > 0)),
    /** Deletes ids whose token can no longer be presented. */
    purgeExpired: (now: number) =>
      database
        .query("ReplayGuard.purgeExpired", (db) =>
          db.delete(oidcJti).where(lte(oidcJti.expiresAt, now)).returning({ jti: oidcJti.jti }),
        )
        .pipe(Effect.map((rows) => rows.length)),
  };
});

export class ReplayGuard extends Context.Service<ReplayGuard, Effect.Success<typeof replayGuard>>()(
  "@repo/db/ReplayGuard",
) {}

export const ReplayGuardLive = Layer.effect(ReplayGuard, replayGuard);
