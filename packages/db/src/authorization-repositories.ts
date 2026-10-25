import { and, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import {
  clampPolicy,
  defaultInstancePolicy,
  InstancePolicy,
  tightenPolicy,
  type IdentityCeilings,
} from "@repo/deploy-config";
import { Database } from "./database.ts";
import * as schema from "./schema/index.ts";

const decodePermissions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.String))),
);

const decodePolicy = Schema.decodeUnknownEffect(InstancePolicy);

const membershipRepo = Effect.gen(function* () {
  const database = yield* Database;

  return {
    read: (userId: string, sessionId: string, orgId: string, now: number) =>
      Effect.gen(function* () {
        const [live] = yield* database.query("MembershipRepo.session", (db) =>
          db
            .select({ user: schema.user, session: schema.session })
            .from(schema.session)
            .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
            .where(
              and(
                eq(schema.session.id, sessionId),
                eq(schema.session.userId, userId),
                gt(schema.session.expiresAt, new Date(now)),
              ),
            ),
        );

        const [member] = yield* database.query("MembershipRepo.member", (db) =>
          db
            .select()
            .from(schema.member)
            .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId))),
        );

        const [elevation] = yield* database.query("MembershipRepo.elevation", (db) =>
          db
            .select()
            .from(schema.orgElevation)
            .where(
              and(
                eq(schema.orgElevation.orgId, orgId),
                eq(schema.orgElevation.userId, userId),
                eq(schema.orgElevation.sessionId, sessionId),
                gt(schema.orgElevation.expiresAt, now),
              ),
            ),
        );

        const custom = yield* database.query("MembershipRepo.roles", (db) =>
          db
            .select()
            .from(schema.organizationRole)
            .where(eq(schema.organizationRole.organizationId, orgId)),
        );

        const customPermissions: Record<string, Record<string, readonly string[]>> = {};

        for (const row of custom)
          customPermissions[row.role] = yield* decodePermissions(row.permission);

        return {
          active: !!live && !live.user.banned && !live.session.impersonatedBy,
          instanceRole: live?.user.role ?? "member",
          roles: member?.role.split(",").map((role) => role.trim()) ?? [],
          member: member !== undefined,
          elevated: elevation !== undefined,
          customPermissions,
        };
      }),
  };
});

export class MembershipRepo extends Context.Service<
  MembershipRepo,
  Effect.Success<typeof membershipRepo>
>()("@repo/db/MembershipRepo") {}

export const MembershipRepoLive = Layer.effect(MembershipRepo, membershipRepo);

const settingsRepo = Effect.gen(function* () {
  const database = yield* Database;

  return {
    policy: (orgId: string, ceilings: IdentityCeilings = {}) =>
      Effect.gen(function* () {
        const [instance] = yield* database.query("InstanceSettingsRepo.instance", (db) =>
          db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)),
        );

        const parent = clampPolicy(
          instance ? yield* decodePolicy(instance.settings) : defaultInstancePolicy,
          ceilings,
        );

        const [org] = yield* database.query("InstanceSettingsRepo.org", (db) =>
          db
            .select()
            .from(schema.organizationPolicy)
            .where(eq(schema.organizationPolicy.orgId, orgId)),
        );

        if (!org) return parent;
        const requested = yield* decodePolicy(org.settings);

        return yield* Effect.try(() => tightenPolicy(parent, requested));
      }),
    resource: (orgId: string, projectId?: string) =>
      Effect.gen(function* () {
        const [org] = yield* database.query("InstanceSettingsRepo.organization", (db) =>
          db.select().from(schema.organization).where(eq(schema.organization.id, orgId)),
        );

        const [state] = yield* database.query("InstanceSettingsRepo.lifecycle", (db) =>
          db.select().from(schema.orgLifecycle).where(eq(schema.orgLifecycle.orgId, orgId)),
        );

        const [project] =
          projectId === undefined
            ? []
            : yield* database.query("InstanceSettingsRepo.project", (db) =>
                db
                  .select()
                  .from(schema.project)
                  .where(and(eq(schema.project.id, projectId), eq(schema.project.orgId, orgId))),
              );

        const [deletion] =
          projectId === undefined
            ? []
            : yield* database.query("InstanceSettingsRepo.deletion", (db) =>
                db
                  .select()
                  .from(schema.projectDeletion)
                  .where(eq(schema.projectDeletion.projectId, projectId)),
              );

        return {
          deleted: deletion !== undefined,
          exists: org !== undefined && (projectId === undefined || project !== undefined),
          orgArchived: state?.archivedAt != null,
          archived: project?.archivedAt != null,
        };
      }),
  };
});

export class InstanceSettingsRepo extends Context.Service<
  InstanceSettingsRepo,
  Effect.Success<typeof settingsRepo>
>()("@repo/db/InstanceSettingsRepo") {}

export const InstanceSettingsRepoLive = Layer.effect(InstanceSettingsRepo, settingsRepo);
