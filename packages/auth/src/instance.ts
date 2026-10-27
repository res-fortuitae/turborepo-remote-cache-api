import type { SessionReader } from "./session-reader.ts";
import type { AuditLogService, AuditInput } from "@repo/audit";
import {
  schema,
  type DatabaseDrizzle,
  type DatabaseQueries,
  type DatabaseStatement,
} from "@repo/db";
import { deleteOrganizationProjects } from "@repo/db";
import {
  InstancePolicy,
  defaultInstancePolicy,
  clampPolicy,
  type AuthSettings,
} from "@repo/deploy-config";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { z } from "zod";

import { requirePasskeyProof } from "./passkey-proof.ts";

const decodePolicy = Schema.decodeUnknownSync(InstancePolicy);

export const readInstancePolicy = async (db: DatabaseDrizzle, config: AuthSettings) => {
  const [row] = await db
    .select()
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1));

  return clampPolicy(
    row === undefined ? defaultInstancePolicy : decodePolicy(row.settings),
    config.identityCeilings ?? {},
  );
};

export const instancePlugin = (
  readSession: SessionReader,
  db: DatabaseDrizzle,
  config: AuthSettings,
  audit?: AuditLogService,
) => {
  const commit = async (
    input: AuditInput,
    change: (db: DatabaseQueries) => readonly DatabaseStatement[],
  ) => {
    if (audit === undefined)
      throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit logging unavailable" });

    return Effect.runPromise(audit.commit(input, change));
  };

  const guard = createAuthMiddleware(async (ctx) => {
    const cached = await readSession(ctx.headers);

    if (!cached) throw new APIError("UNAUTHORIZED");

    const [live] = await db
      .select({ user: schema.user, session: schema.session })
      .from(schema.session)
      .innerJoin(schema.user, eq(schema.session.userId, schema.user.id))
      .where(
        and(
          eq(schema.session.token, cached.session.token),
          gt(schema.session.expiresAt, new Date()),
        ),
      );

    if (!live || live.user.banned || live.session.impersonatedBy) throw new APIError("FORBIDDEN");

    if (
      live.user.role !== "owner" &&
      live.user.role !== "admin" &&
      !(ctx.path === "/instance/orgs" && live.user.role === "auditor")
    )
      throw new APIError("FORBIDDEN");

    if (
      ctx.method === "POST" &&
      ctx.path !== "/instance/orgs/leave" &&
      (await readInstancePolicy(db, config)).requirePasskeyForAdmins
    )
      await requirePasskeyProof(db, live.session.id, live.user.id);

    return { session: live };
  });

  const event = (
    user: { id: string; name: string },
    action: string,
    target: string,
    reason?: string,
  ): AuditInput => ({
    scope: "instance",
    actor: { type: "instanceAdmin", id: user.id, display: user.name },
    action,
    target: { type: "instance", id: target },
    outcome: "allow",
    reason,
    ip: "",
    userAgent: "",
    requestId: crypto.randomUUID(),
    metadata: {},
  });

  return {
    id: "instance-policy",
    endpoints: {
      instanceNotifications: createAuthEndpoint(
        "/instance/notifications",
        { method: "GET", use: [guard] },
        async (ctx) =>
          ctx.json({
            notifications: await db
              .select()
              .from(schema.notification)
              .where(eq(schema.notification.userId, ctx.context.session.user.id))
              .limit(100),
          }),
      ),
      instanceSettings: createAuthEndpoint(
        "/instance/settings",
        { method: "GET", use: [guard] },
        async (ctx) =>
          ctx.json({
            policy: await readInstancePolicy(db, config),
            ceilings: config.identityCeilings ?? {},
          }),
      ),
      updateInstanceSettings: createAuthEndpoint(
        "/instance/settings",
        { method: "POST", use: [guard], body: z.object({ policy: z.unknown() }) },
        async (ctx) => {
          let policy;

          try {
            policy = clampPolicy(decodePolicy(ctx.body.policy), config.identityCeilings ?? {});
          } catch {
            throw new APIError("BAD_REQUEST", { message: "Invalid instance policy" });
          }

          if (policy.requirePasskeyForAdmins)
            await requirePasskeyProof(
              db,
              ctx.context.session.session.id,
              ctx.context.session.user.id,
            );

          await commit(
            event(ctx.context.session.user, "instance.settings.update", "instance"),
            (db) => [
              db
                .insert(schema.instanceSettings)
                .values({
                  id: 1,
                  schemaVersion: 1,
                  settings: {
                    ...policy,
                    allowedEmailDomains: [...policy.allowedEmailDomains],
                    allowedGithubOrgs: [...policy.allowedGithubOrgs],
                    allowedOidcIssuers: [...policy.allowedOidcIssuers],
                  },
                  updatedAt: Date.now(),
                })
                .onConflictDoUpdate({
                  target: schema.instanceSettings.id,
                  set: {
                    settings: {
                      ...policy,
                      allowedEmailDomains: [...policy.allowedEmailDomains],
                      allowedGithubOrgs: [...policy.allowedGithubOrgs],
                      allowedOidcIssuers: [...policy.allowedOidcIssuers],
                    },
                    updatedAt: Date.now(),
                  },
                }),
            ],
          );

          return ctx.json({ policy });
        },
      ),
      listInstanceOrganizations: createAuthEndpoint(
        "/instance/orgs",
        { method: "GET", use: [guard], query: z.object({ cursor: z.string().optional() }) },
        async (ctx) => {
          const page = await db
            .select()
            .from(schema.organization)
            .where(ctx.query.cursor ? gt(schema.organization.id, ctx.query.cursor) : undefined)
            .orderBy(asc(schema.organization.id))
            .limit(101);
          const organizations = page.slice(0, 100);
          const ids = organizations.map((org) => org.id);
          const [lifecycle, projects, usage] = ids.length
            ? await Promise.all([
                db
                  .select()
                  .from(schema.orgLifecycle)
                  .where(inArray(schema.orgLifecycle.orgId, ids)),
                db
                  .select({
                    orgId: schema.project.orgId,
                    projects: count(),
                    lastSeenAt: sql<number | null>`max(${schema.project.lastSeenAt})`,
                  })
                  .from(schema.project)
                  .where(inArray(schema.project.orgId, ids))
                  .groupBy(schema.project.orgId),
                db
                  .select({
                    orgId: schema.projectUsage.orgId,
                    bytes: sql<number>`sum(${schema.projectUsage.bytes})`,
                  })
                  .from(schema.projectUsage)
                  .where(inArray(schema.projectUsage.orgId, ids))
                  .groupBy(schema.projectUsage.orgId),
              ])
            : [[], [], []];
          return ctx.json({
            organizations: organizations.map((org) => ({
              ...org,
              archivedAt: lifecycle.find((row) => row.orgId === org.id)?.archivedAt ?? null,
              projects: projects.find((row) => row.orgId === org.id)?.projects ?? 0,
              lastSeenAt: projects.find((row) => row.orgId === org.id)?.lastSeenAt ?? null,
              storageBytes: usage.find((row) => row.orgId === org.id)?.bytes ?? 0,
            })),
            nextCursor: page.length > 100 ? (organizations.at(-1)?.id ?? null) : null,
          });
        },
      ),
      listElevations: createAuthEndpoint(
        "/instance/orgs/elevations",
        { method: "GET", use: [guard] },
        async (ctx) =>
          ctx.json({
            elevations: await db
              .select({
                id: schema.orgElevation.id,
                orgId: schema.orgElevation.orgId,
                reason: schema.orgElevation.reason,
                expiresAt: schema.orgElevation.expiresAt,
                organization: {
                  id: schema.organization.id,
                  name: schema.organization.name,
                  slug: schema.organization.slug,
                },
              })
              .from(schema.orgElevation)
              .innerJoin(schema.organization, eq(schema.organization.id, schema.orgElevation.orgId))
              .where(
                and(
                  eq(schema.orgElevation.userId, ctx.context.session.user.id),
                  eq(schema.orgElevation.sessionId, ctx.context.session.session.id),
                  gt(schema.orgElevation.expiresAt, Date.now()),
                ),
              )
              .limit(100),
          }),
      ),
      leaveElevation: createAuthEndpoint(
        "/instance/orgs/leave",
        { method: "POST", use: [guard], body: z.object({ orgId: z.string().min(1) }) },
        async (ctx) => {
          await commit(
            {
              ...event(ctx.context.session.user, "instance.org.leave", ctx.body.orgId),
              scope: "org",
              orgId: ctx.body.orgId,
            },
            (q) => [
              q
                .delete(schema.orgElevation)
                .where(
                  and(
                    eq(schema.orgElevation.userId, ctx.context.session.user.id),
                    eq(schema.orgElevation.sessionId, ctx.context.session.session.id),
                    eq(schema.orgElevation.orgId, ctx.body.orgId),
                  ),
                ),
            ],
          );
          return ctx.json({ success: true });
        },
      ),
      createInstanceOrganization: createAuthEndpoint(
        "/instance/orgs/create",
        {
          method: "POST",
          use: [guard],
          body: z.object({
            name: z.string().min(1).max(100),
            slug: z
              .string()
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .max(64),
            ownerId: z.string().min(1),
          }),
        },
        async (ctx) => {
          const [lead] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, ctx.body.ownerId));

          if (!lead || lead.banned)
            throw new APIError("BAD_REQUEST", { message: "Active owner required" });

          const org = {
            id: crypto.randomUUID(),
            name: ctx.body.name,
            slug: ctx.body.slug,
            createdAt: new Date(),
          };

          await commit(event(ctx.context.session.user, "instance.org.create", org.id), (db) => [
            db.insert(schema.organization).values(org),
            db.insert(schema.member).values({
              id: crypto.randomUUID(),
              organizationId: org.id,
              userId: lead.id,
              role: "owner",
              createdAt: new Date(),
            }),
          ]);

          return ctx.json({ organization: org });
        },
      ),
      elevateOrganization: createAuthEndpoint(
        "/instance/orgs/elevate",
        {
          method: "POST",
          use: [guard],
          body: z.object({
            orgId: z.string().min(1),
            reason: z.string().trim().min(1).max(1000),
            ttlSeconds: z.number().int().min(1).max(900).default(300),
          }),
        },
        async (ctx) => {
          const [org] = await db
            .select()
            .from(schema.organization)
            .where(eq(schema.organization.id, ctx.body.orgId));

          if (!org) throw new APIError("NOT_FOUND");

          const elevation = {
            id: crypto.randomUUID(),
            userId: ctx.context.session.user.id,
            sessionId: ctx.context.session.session.id,
            orgId: org.id,
            reason: ctx.body.reason,
            expiresAt: Date.now() + ctx.body.ttlSeconds * 1000,
          };

          const input = {
            ...event(ctx.context.session.user, "instance.org.elevate", org.id, ctx.body.reason),
            scope: "org" as const,
            orgId: org.id,
            metadata: { expiresAt: elevation.expiresAt },
          };

          await commit(input, (db) => [
            db
              .delete(schema.orgElevation)
              .where(
                and(
                  eq(schema.orgElevation.userId, elevation.userId),
                  eq(schema.orgElevation.sessionId, elevation.sessionId),
                  eq(schema.orgElevation.orgId, elevation.orgId),
                ),
              ),
            db.insert(schema.orgElevation).values(elevation),
          ]);

          return ctx.json({ elevation });
        },
      ),
      manageInstanceOrganization: createAuthEndpoint(
        "/instance/orgs/manage",
        {
          method: "POST",
          use: [guard],
          body: z.object({
            orgId: z.string().min(1),
            action: z.enum(["archive", "restore", "delete", "transfer"]),
            ownerId: z.string().optional(),
            reason: z.string().trim().min(1).max(1000),
          }),
        },
        async (ctx) => {
          const { orgId, action, ownerId } = ctx.body;
          const actor = ctx.context.session.user;

          const [elevation] = await db
            .select()
            .from(schema.orgElevation)
            .where(
              and(
                eq(schema.orgElevation.userId, actor.id),
                eq(schema.orgElevation.sessionId, ctx.context.session.session.id),
                eq(schema.orgElevation.orgId, orgId),
                gt(schema.orgElevation.expiresAt, Date.now()),
              ),
            );

          if (!elevation)
            throw new APIError("FORBIDDEN", { message: "Explicit org elevation is required" });

          const [org] = await db
            .select()
            .from(schema.organization)
            .where(eq(schema.organization.id, orgId));

          if (!org) throw new APIError("NOT_FOUND");

          if (action === "transfer") {
            const [lead] = ownerId
              ? await db.select().from(schema.user).where(eq(schema.user.id, ownerId))
              : [];

            if (!lead || lead.banned)
              throw new APIError("BAD_REQUEST", { message: "Active owner required" });
            await commit(
              {
                ...event(actor, "instance.org.transfer", orgId, ctx.body.reason),
                scope: "org",
                orgId,
              },
              (db) => [
                db
                  .update(schema.member)
                  .set({ role: "admin" })
                  .where(
                    and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")),
                  ),
                db
                  .insert(schema.member)
                  .values({
                    id: crypto.randomUUID(),
                    organizationId: orgId,
                    userId: lead.id,
                    role: "owner",
                    createdAt: new Date(),
                  })
                  .onConflictDoNothing(),
                db
                  .update(schema.member)
                  .set({ role: "owner" })
                  .where(
                    and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, lead.id)),
                  ),
              ],
            );
          } else if (action === "delete") {
            await commit(
              {
                ...event(actor, "instance.org.delete", orgId, ctx.body.reason),
                scope: "org",
                orgId,
              },
              (db) => [
                ...deleteOrganizationProjects(db, orgId, Date.now()),
                db.delete(schema.organization).where(eq(schema.organization.id, orgId)),
                db.delete(schema.orgElevation).where(eq(schema.orgElevation.orgId, orgId)),
                db.delete(schema.orgLifecycle).where(eq(schema.orgLifecycle.orgId, orgId)),
              ],
            );
          } else {
            await commit(
              {
                ...event(actor, `instance.org.${action}`, orgId, ctx.body.reason),
                scope: "org",
                orgId,
              },
              (db) => [
                db
                  .insert(schema.orgLifecycle)
                  .values({ orgId, archivedAt: action === "archive" ? Date.now() : null })
                  .onConflictDoUpdate({
                    target: schema.orgLifecycle.orgId,
                    set: { archivedAt: action === "archive" ? Date.now() : null },
                  }),
              ],
            );
          }

          return ctx.json({ success: true });
        },
      ),
      setInstanceRole: createAuthEndpoint(
        "/instance/set-role",
        {
          method: "POST",
          use: [guard],
          body: z.object({
            userId: z.string().min(1),
            role: z.enum(["owner", "admin", "auditor", "member"]),
          }),
        },
        async (ctx) => {
          const actor = ctx.context.session.user;

          const [target] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, ctx.body.userId));

          if (!target) throw new APIError("NOT_FOUND");

          if (actor.role !== "owner" && (target.role === "owner" || ctx.body.role === "owner"))
            throw new APIError("FORBIDDEN");
          await commit(event(actor, "instance.user.role", target.id), (db) => [
            db
              .update(schema.user)
              .set({ role: ctx.body.role })
              .where(
                and(
                  eq(schema.user.id, target.id),
                  // SQL runs atomically: concurrent demotions cannot remove the last owner.
                  sql`(${schema.user.role} != 'owner' or ${ctx.body.role} = 'owner' or (select count(*) from user where role = 'owner' and coalesce(banned, 0) = 0) > 1)`,
                ),
              ),
            db.delete(schema.session).where(eq(schema.session.userId, target.id)),
          ]);

          const [updated] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, target.id));

          if (updated?.role !== ctx.body.role)
            throw new APIError("CONFLICT", { message: "The instance must retain an active owner" });

          return ctx.json({ user: updated });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path?.startsWith("/admin/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            // Re-check D1 even when the plugin is called through its native HTTP API.
            const cached = await readSession(ctx.headers);

            if (!cached) throw new APIError("UNAUTHORIZED");

            const [live] = await db
              .select({ user: schema.user, session: schema.session })
              .from(schema.session)
              .innerJoin(schema.user, eq(schema.session.userId, schema.user.id))
              .where(
                and(
                  eq(schema.session.token, cached.session.token),
                  gt(schema.session.expiresAt, new Date()),
                ),
              );

            if (ctx.path === "/admin/stop-impersonating" && live?.session.impersonatedBy) return;

            if (!live || live.user.banned || live.session.impersonatedBy)
              throw new APIError("FORBIDDEN");

            const read = [
              "/admin/list-users",
              "/admin/get-user",
              "/admin/list-user-sessions",
              "/admin/has-permission",
            ].includes(ctx.path);

            if (read) return;

            if ((await readInstancePolicy(db, config)).requirePasskeyForAdmins)
              await requirePasskeyProof(db, live.session.id, live.user.id);

            if (live.user.role !== "owner" && live.user.role !== "admin")
              throw new APIError("FORBIDDEN");

            if (
              [
                "/admin/set-role",
                "/admin/create-user",
                "/admin/update-user",
                "/admin/set-user-password",
                "/admin/remove-user",
              ].includes(ctx.path)
            )
              throw new APIError("FORBIDDEN", { message: "Use the instance policy endpoints" });

            const body = z
              .object({
                userId: z.string().optional(),
                reason: z.string().trim().min(1).max(1000).optional(),
              })
              .parse(ctx.body ?? {});

            const [target] = body.userId
              ? await db.select().from(schema.user).where(eq(schema.user.id, body.userId))
              : [];

            if (target?.role === "owner" && ctx.path !== "/admin/unban-user")
              throw new APIError("FORBIDDEN", { message: "Demote owners before deactivation" });

            if (
              ctx.path === "/admin/impersonate-user" &&
              (live.user.role !== "owner" || !body.reason)
            )
              throw new APIError("FORBIDDEN", { message: "Owner and reason required" });
            // The audited database adapter records intent and confirmation for native admin writes.
          }),
        },
      ],
    },
  };
};
