import type { SessionReader } from "./session-reader.ts";
import type { AuditInput, AuditLogService } from "@repo/audit";
import {
  schema,
  type DatabaseDrizzle,
  type DatabaseQueries,
  type DatabaseStatement,
} from "@repo/db";
import { deleteOrganizationProjects } from "@repo/db";
import { InstancePolicy, tightenPolicy, type AuthSettings } from "@repo/deploy-config";
import * as Schema from "effect/Schema";
import {
  effectiveOrganizationPermissions,
  organizationAccess,
  organizationRoles,
  hasOrganizationPermission,
  canDelegateOrganizationRole,
} from "./organization-access.ts";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { and, eq, gt, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { readInstancePolicy } from "./instance.ts";
import { signInviteLink, verifyInviteLink } from "./invite-link.ts";

export const organizationPlugins = (
  readSession: SessionReader,
  db: DatabaseDrizzle,
  config: AuthSettings,
  audit?: AuditLogService,
  sendInvitation?: (email: string, org: string, url: string) => Promise<boolean>,
) => {
  const record = (
    input: AuditInput,
    change: (db: DatabaseQueries) => readonly DatabaseStatement[] = () => [],
  ) => {
    if (!audit) throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit unavailable" });

    return Effect.runPromise(audit.commit(input, change));
  };

  const event = (
    user: { id: string; name: string },
    orgId: string,
    action: string,
    target: string,
  ): AuditInput => ({
    scope: "org",
    orgId,
    actor: { type: "user", id: user.id, display: user.name },
    action,
    target: { type: "organization", id: target },
    outcome: "allow",
    ip: "",
    userAgent: "",
    requestId: crypto.randomUUID(),
    metadata: {},
  });

  const activeOrg = async (id: string) => {
    const [state] = await db
      .select()
      .from(schema.orgLifecycle)
      .where(eq(schema.orgLifecycle.orgId, id));

    if (state?.archivedAt) throw new APIError("FORBIDDEN", { message: "Organization is archived" });
  };

  const fresh = createAuthMiddleware(async (ctx) => {
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

    return { session: live };
  });

  const adminMember = async (orgId: string, userId: string) => {
    await activeOrg(orgId);

    const [member] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));

    if (!member || !(await hasOrganizationPermission(db, orgId, userId, "invitation", "create")))
      throw new APIError("FORBIDDEN");

    return member;
  };

  const eligibleEmail = async (email: string) => {
    const policy = await readInstancePolicy(db, config);

    if (
      policy.allowedEmailDomains.length &&
      !policy.allowedEmailDomains.some(
        (domain) => domain.toLowerCase() === email.split("@")[1]?.toLowerCase(),
      )
    )
      throw new APIError("FORBIDDEN", {
        message: "Recipient is outside the instance signup policy",
      });

    if (policy.allowedGithubOrgs.length) {
      const [recipient] = await db
        .select()
        .from(schema.user)
        .where(sql`lower(${schema.user.email}) = ${email.toLowerCase()}`);

      if (!recipient)
        throw new APIError("FORBIDDEN", {
          message: "Recipient must sign in under the GitHub signup policy first",
        });
    }
  };

  const recipientEligible = async (userId: string, email: string) => {
    await eligibleEmail(email);
    const policy = await readInstancePolicy(db, config);

    if (!policy.allowedGithubOrgs.length) return;

    const [account] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")));

    if (!account?.githubLogin) throw new APIError("FORBIDDEN");

    const identity = await fetch(
      `https://api.github.com/users/${encodeURIComponent(account.githubLogin)}`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "turborepo-remote-cache" },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!identity.ok) throw new APIError("FORBIDDEN");

    const profile = z
      .object({ id: z.union([z.string(), z.number()]) })
      .parse(await identity.json());

    if (String(profile.id) !== account.accountId)
      throw new APIError("FORBIDDEN", { message: "GitHub username changed; sign in again" });
    let allowed = false;

    for (const org of policy.allowedGithubOrgs) {
      const response = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(account.githubLogin)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "turborepo-remote-cache",
          },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (response.status === 204) allowed = true;
    }

    if (!allowed) throw new APIError("FORBIDDEN");
  };

  return [
    organization({
      allowUserToCreateOrganization: async (user) => {
        const [live] = await db.select().from(schema.user).where(eq(schema.user.id, user.id));
        const policy = await readInstancePolicy(db, config);

        return (
          !!live &&
          !live.banned &&
          (policy.orgCreation === "anyone" || live.role === "owner" || live.role === "admin")
        );
      },
      ac: organizationAccess,
      roles: organizationRoles,
      dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 50 },
      teams: {
        enabled: true,
        defaultTeam: { enabled: false },
        allowRemovingAllTeams: true,
        maximumTeams: config.groups?.maxGroups ?? 50,
        maximumMembersPerTeam: config.groups?.maxMembersPerGroup ?? 1000,
      },
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        beforeCreateTeam: async ({ organization: org }) => {
          await activeOrg(org.id);
        },
        beforeUpdateTeam: async ({ organization: org }) => {
          await activeOrg(org.id);
        },
        beforeDeleteTeam: async ({ organization: org }) => {
          await activeOrg(org.id);
        },
        beforeAddTeamMember: async ({ teamMember, organization: org }) => {
          await activeOrg(org.id);

          const [member] = await db
            .select()
            .from(schema.member)
            .where(
              and(
                eq(schema.member.organizationId, org.id),
                eq(schema.member.userId, teamMember.userId),
              ),
            );

          if (!member)
            throw new APIError("FORBIDDEN", {
              message: "Groups contain organization members only",
            });
        },

        beforeCreateOrganization: async ({ organization: org }) => {
          if (!org.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(org.slug) || org.slug.length > 64)
            throw new APIError("BAD_REQUEST", { message: "Invalid TURBO_TEAM slug" });
        },

        beforeUpdateOrganization: async ({ organization: org, member }) => {
          if (org.slug !== undefined)
            throw new APIError("BAD_REQUEST", { message: "TURBO_TEAM slug is immutable" });
          await activeOrg(member.organizationId);
        },

        beforeDeleteOrganization: async ({ organization: org, user }) => {
          await record(event(user, org.id, "org.delete.requested", org.id), (db) =>
            deleteOrganizationProjects(db, org.id, Date.now()),
          );
        },
        afterDeleteOrganization: async ({ organization: org, user }) => {
          await record(event(user, org.id, "org.deleted", org.id), (db) => [
            db.delete(schema.orgLifecycle).where(eq(schema.orgLifecycle.orgId, org.id)),
            db.delete(schema.orgElevation).where(eq(schema.orgElevation.orgId, org.id)),
            db.delete(schema.organizationPolicy).where(eq(schema.organizationPolicy.orgId, org.id)),
          ]);
        },
        beforeRemoveMember: async ({ member, organization: org }) => {
          if (member.role.split(",").includes("owner"))
            throw new APIError("FORBIDDEN", {
              message: "Transfer ownership before removing an owner",
            });
          await activeOrg(org.id);
        },
        beforeUpdateMemberRole: async ({ member, organization: org, newRole }) => {
          if (member.role.split(",").includes("owner"))
            throw new APIError("FORBIDDEN", { message: "Use elevated ownership transfer" });
          await activeOrg(org.id);

          if (newRole.split(",").includes("owner"))
            throw new APIError("FORBIDDEN", { message: "Use organization ownership transfer" });
        },
      },
    }),
    {
      id: "organization-policy",
      endpoints: {
        myOrganizationPermissions: createAuthEndpoint(
          "/organization/my-permissions",
          { method: "GET", use: [fresh], query: z.object({ organizationId: z.string() }) },
          async (ctx) => {
            await activeOrg(ctx.query.organizationId);
            const own = await effectiveOrganizationPermissions(
              db,
              ctx.query.organizationId,
              ctx.context.session.user.id,
            );
            if (!own) throw new APIError("FORBIDDEN");
            return ctx.json(own);
          },
        ),
        transferOrganizationOwnership: createAuthEndpoint(
          "/organization/transfer-ownership",
          {
            method: "POST",
            use: [fresh],
            body: z.object({ organizationId: z.string(), newOwnerId: z.string() }),
          },
          async (ctx) => {
            const orgId = ctx.body.organizationId;
            await activeOrg(orgId);

            if (
              !(await hasOrganizationPermission(
                db,
                orgId,
                ctx.context.session.user.id,
                "organization",
                "transfer",
              ))
            )
              throw new APIError("FORBIDDEN");

            const [lead] = await db
              .select()
              .from(schema.member)
              .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
              .where(
                and(
                  eq(schema.member.organizationId, orgId),
                  eq(schema.member.userId, ctx.body.newOwnerId),
                ),
              );

            if (!lead || lead.user.banned)
              throw new APIError("BAD_REQUEST", {
                message: "New owner must be an active org member",
              });
            await record(
              event(
                ctx.context.session.user,
                orgId,
                "org.ownership.transferred",
                ctx.body.newOwnerId,
              ),
              (db) => [
                db
                  .update(schema.member)
                  .set({ role: "admin" })
                  .where(
                    and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")),
                  ),
                db
                  .update(schema.member)
                  .set({ role: "owner" })
                  .where(
                    and(
                      eq(schema.member.organizationId, orgId),
                      eq(schema.member.userId, ctx.body.newOwnerId),
                    ),
                  ),
              ],
            );

            return ctx.json({ success: true });
          },
        ),
        organizationPolicy: createAuthEndpoint(
          "/organization/policy",
          {
            method: "POST",
            use: [fresh],
            body: z.object({ organizationId: z.string(), policy: z.unknown().optional() }),
          },
          async (ctx) => {
            const orgId = ctx.body.organizationId;
            await activeOrg(orgId);

            if (
              !(await hasOrganizationPermission(
                db,
                orgId,
                ctx.context.session.user.id,
                "settings",
                "update",
              ))
            )
              throw new APIError("FORBIDDEN");
            const instance = await readInstancePolicy(db, config);

            if (ctx.body.policy === undefined) {
              const [row] = await db
                .select()
                .from(schema.organizationPolicy)
                .where(eq(schema.organizationPolicy.orgId, orgId));

              return ctx.json({
                policy: row
                  ? tightenPolicy(instance, Schema.decodeUnknownSync(InstancePolicy)(row.settings))
                  : instance,
              });
            }

            let policy;

            try {
              policy = tightenPolicy(
                instance,
                Schema.decodeUnknownSync(InstancePolicy)(ctx.body.policy),
              );
            } catch {
              throw new APIError("BAD_REQUEST");
            }

            const settings = {
              ...policy,
              allowedEmailDomains: [...policy.allowedEmailDomains],
              allowedGithubOrgs: [...policy.allowedGithubOrgs],
              allowedOidcIssuers: [...policy.allowedOidcIssuers],
            };

            await record(
              event(ctx.context.session.user, orgId, "org.policy.update", orgId),
              (db) => [
                db
                  .insert(schema.organizationPolicy)
                  .values({ orgId, settings, updatedAt: Date.now() })
                  .onConflictDoUpdate({
                    target: schema.organizationPolicy.orgId,
                    set: { settings, updatedAt: Date.now() },
                  }),
              ],
            );

            return ctx.json({ policy });
          },
        ),
        inviteOrganizationMember: createAuthEndpoint(
          "/organization/invite",
          {
            method: "POST",
            use: [fresh],
            body: z.object({
              organizationId: z.string(),
              email: z.email().optional(),
              githubUsername: z
                .string()
                .regex(/^[a-zA-Z0-9-]{1,39}$/)
                .optional(),
              role: z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .default("member"),
            }),
          },
          async (ctx) => {
            const user = ctx.context.session.user;
            await adminMember(ctx.body.organizationId, user.id);

            if (
              !(await canDelegateOrganizationRole(
                db,
                ctx.body.organizationId,
                user.id,
                ctx.body.role,
              ))
            )
              throw new APIError("FORBIDDEN", {
                message: "Cannot delegate this organization role",
              });
            let email = ctx.body.email?.toLowerCase();

            if (ctx.body.githubUsername) {
              const [recipient] = await db
                .select({ email: schema.user.email, id: schema.user.id })
                .from(schema.account)
                .innerJoin(schema.user, eq(schema.account.userId, schema.user.id))
                .where(
                  and(
                    sql`lower(${schema.account.githubLogin}) = ${ctx.body.githubUsername.toLowerCase()}`,
                    eq(schema.account.providerId, "github"),
                  ),
                );

              if (!recipient)
                throw new APIError("BAD_REQUEST", {
                  message: "GitHub recipient must sign in once before a username invitation",
                });
              email = recipient.email.toLowerCase();
              await recipientEligible(recipient.id, email);
            }

            if (!email)
              throw new APIError("BAD_REQUEST", { message: "Email or GitHub username required" });
            await eligibleEmail(email);

            const [knownRecipient] = await db
              .select()
              .from(schema.user)
              .where(sql`lower(${schema.user.email}) = ${email}`);

            if (knownRecipient) await recipientEligible(knownRecipient.id, email);
            const key = `${user.id}:${ctx.body.organizationId}:${Math.floor(Date.now() / 3600000)}`;

            const [window] = await db
              .insert(schema.invitationWindow)
              .values({ key, count: 1 })
              .onConflictDoUpdate({
                target: schema.invitationWindow.key,
                set: { count: sql`${schema.invitationWindow.count} + 1` },
              })
              .returning();

            if (!window || window.count > 10) throw new APIError("TOO_MANY_REQUESTS");

            const [org] = await db
              .select()
              .from(schema.organization)
              .where(eq(schema.organization.id, ctx.body.organizationId));

            if (!org) throw new APIError("NOT_FOUND");

            const invitation = {
              id: crypto.randomUUID(),
              organizationId: org.id,
              inviterId: user.id,
              email,
              role: ctx.body.role,
              status: "pending",
              expiresAt: new Date(Date.now() + 48 * 3600000),
              createdAt: new Date(),
            };

            await record(event(user, org.id, "org.invitation.created", invitation.id), (db) => [
              db.insert(schema.invitation).values(invitation),
            ]);
            const url = await signInviteLink(config, invitation.id, invitation.expiresAt);
            const delivered = sendInvitation ? await sendInvitation(email, org.name, url) : false;
            await record(
              event(
                user,
                org.id,
                delivered ? "org.invitation.mail.accepted" : "org.invitation.link.created",
                invitation.id,
              ),
            );

            return ctx.json({ invitation, url, delivered });
          },
        ),
        // Native list-team-members only answers members of that team; administrators
        // and access explanations need group composition for any group in the org.
        listOrganizationGroupMembers: createAuthEndpoint(
          "/organization/group-members",
          {
            method: "GET",
            use: [fresh],
            query: z.object({ organizationId: z.string(), teamId: z.string() }),
          },
          async (ctx) => {
            const { organizationId, teamId } = ctx.query;
            await activeOrg(organizationId);
            const [caller] = await db
              .select()
              .from(schema.member)
              .where(
                and(
                  eq(schema.member.organizationId, organizationId),
                  eq(schema.member.userId, ctx.context.session.user.id),
                ),
              );

            if (!caller) throw new APIError("FORBIDDEN");
            const [group] = await db
              .select()
              .from(schema.team)
              .where(
                and(eq(schema.team.id, teamId), eq(schema.team.organizationId, organizationId)),
              );

            if (!group) throw new APIError("NOT_FOUND");

            return ctx.json(
              await db
                .select({
                  id: schema.teamMember.id,
                  teamId: schema.teamMember.teamId,
                  userId: schema.teamMember.userId,
                })
                .from(schema.teamMember)
                .where(eq(schema.teamMember.teamId, teamId)),
            );
          },
        ),
        organizationInvitationLink: createAuthEndpoint(
          "/organization/invitation-link",
          { method: "POST", use: [fresh], body: z.object({ invitationId: z.string() }) },
          async (ctx) => {
            const [invitation] = await db
              .select()
              .from(schema.invitation)
              .where(eq(schema.invitation.id, ctx.body.invitationId));

            if (
              !invitation ||
              invitation.status !== "pending" ||
              invitation.expiresAt.getTime() <= Date.now()
            )
              throw new APIError("NOT_FOUND");
            await adminMember(invitation.organizationId, ctx.context.session.user.id);

            return ctx.json({
              url: await signInviteLink(config, invitation.id, invitation.expiresAt),
            });
          },
        ),
        acceptSignedOrganizationInvitation: createAuthEndpoint(
          "/organization/accept-signed-invitation",
          {
            method: "POST",
            use: [fresh],
            body: z.object({ invitationId: z.string(), signature: z.string() }),
          },
          async (ctx) => {
            const user = ctx.context.session.user;

            const [invitation] = await db
              .select()
              .from(schema.invitation)
              .where(eq(schema.invitation.id, ctx.body.invitationId));

            if (
              !invitation ||
              invitation.status !== "pending" ||
              !user.emailVerified ||
              invitation.email.toLowerCase() !== user.email.toLowerCase()
            )
              throw new APIError("FORBIDDEN");
            await activeOrg(invitation.organizationId);
            await recipientEligible(user.id, user.email);

            if (
              !(await verifyInviteLink(
                config,
                invitation.id,
                invitation.expiresAt,
                ctx.body.signature,
              ))
            )
              throw new APIError("FORBIDDEN");
            const nonce = crypto.randomUUID();
            const memberId = crypto.randomUUID();
            await record(
              event(user, invitation.organizationId, "org.invitation.accepted", invitation.id),
              (db) => [
                db.insert(schema.invitationClaim).select(
                  db
                    .select({
                      invitationId: schema.invitation.id,
                      nonce: sql<string>`${nonce}`.as("nonce"),
                    })
                    .from(schema.invitation)
                    .where(
                      and(
                        eq(schema.invitation.id, invitation.id),
                        eq(schema.invitation.status, "pending"),
                        gt(schema.invitation.expiresAt, new Date()),
                      ),
                    ),
                ),
                db
                  .insert(schema.member)
                  .select(
                    db
                      .select({
                        id: sql<string>`${memberId}`.as("id"),
                        organizationId: sql<string>`${invitation.organizationId}`.as(
                          "organization_id",
                        ),
                        userId: sql<string>`${user.id}`.as("user_id"),
                        role: sql<string>`${invitation.role ?? "member"}`.as("role"),
                        createdAt: sql<Date>`${Date.now()}`.as("created_at"),
                      })
                      .from(schema.invitationClaim)
                      .where(
                        and(
                          eq(schema.invitationClaim.invitationId, invitation.id),
                          eq(schema.invitationClaim.nonce, nonce),
                        ),
                      ),
                  )
                  .onConflictDoNothing(),
                db
                  .update(schema.invitation)
                  .set({ status: "accepted" })
                  .where(
                    and(
                      eq(schema.invitation.id, invitation.id),
                      sql`exists (select 1 from invitation_claim where invitation_id = ${invitation.id} and nonce = ${nonce})`,
                    ),
                  ),
              ],
            );

            const [claim] = await db
              .select()
              .from(schema.invitationClaim)
              .where(eq(schema.invitationClaim.invitationId, invitation.id));

            if (claim?.nonce !== nonce) throw new APIError("CONFLICT");

            return ctx.json({ organizationId: invitation.organizationId });
          },
        ),
      },
      hooks: {
        before: [
          {
            matcher: (ctx: { path?: string }) => ctx.path?.startsWith("/organization/") === true,
            handler: createAuthMiddleware(async (ctx) => {
              if (
                [
                  "/organization/invite-member",
                  "/organization/accept-invitation",
                  "/organization/add-member",
                ].includes(ctx.path)
              )
                throw new APIError("FORBIDDEN", { message: "Use signed organization invitations" });
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

              if (!live || live.user.banned || live.session.impersonatedBy)
                throw new APIError("FORBIDDEN");

              const body = z
                .object({
                  organizationId: z.string().optional(),
                  teamId: z.string().optional(),
                  role: z.union([z.string(), z.array(z.string())]).optional(),
                })
                .passthrough()
                .parse(ctx.body ?? ctx.query ?? {});

              const [targetTeam] = body.teamId
                ? await db.select().from(schema.team).where(eq(schema.team.id, body.teamId))
                : [];

              const orgId =
                targetTeam?.organizationId ??
                body.organizationId ??
                live.session.activeOrganizationId;

              if (orgId) {
                await activeOrg(orgId);

                if (ctx.path === "/organization/update-member-role" && body.role) {
                  const roles = (Array.isArray(body.role) ? body.role : [body.role]).flatMap(
                    (role) => role.split(","),
                  );

                  for (const role of roles)
                    if (!(await canDelegateOrganizationRole(db, orgId, live.user.id, role.trim())))
                      throw new APIError("FORBIDDEN");
                }

                if (ctx.request?.method === "POST")
                  await record(
                    event(
                      live.user,
                      orgId,
                      `org${ctx.path.replaceAll("/organization", "").replaceAll("/", ".")}.requested`,
                      body.teamId ?? orgId,
                    ),
                  );
              }
            }),
          },
        ],
      },
    },
  ];
};
