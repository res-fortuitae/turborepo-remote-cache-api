import type { AuditInput, AuditLogService } from "@repo/audit";
import {
  schema,
  type DatabaseDrizzle,
  type DatabaseQueries,
  type DatabaseStatement,
} from "@repo/db";
import type { AuthSettings } from "@repo/deploy-config";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { and, eq, gt, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { readInstancePolicy } from "./instance.ts";
import { signInviteLink, verifyInviteLink } from "./invite-link.ts";

export const organizationPlugins = (
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
    const cached = await getAuthoritativeSessionFromCtx(ctx);
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
    if (!member || !["owner", "admin"].includes(member.role)) throw new APIError("FORBIDDEN");
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
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        beforeCreateOrganization: async ({ organization: org }) => {
          if (!org.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(org.slug) || org.slug.length > 64)
            throw new APIError("BAD_REQUEST", { message: "Invalid TURBO_TEAM slug" });
        },
        afterCreateOrganization: async ({ organization: org, user }) => {
          await record(event(user, org.id, "org.created", org.id));
        },
        beforeUpdateOrganization: async ({ organization: org, member }) => {
          if (org.slug !== undefined)
            throw new APIError("BAD_REQUEST", { message: "TURBO_TEAM slug is immutable" });
          await activeOrg(member.organizationId);
        },
        afterUpdateOrganization: async ({ organization: org, user, member }) => {
          await record(
            event(user, member.organizationId, "org.updated", org?.id ?? member.organizationId),
          );
        },
        beforeDeleteOrganization: async () => {
          throw new APIError("FORBIDDEN", {
            message: "Use elevated instance org lifecycle operations",
          });
        },
        beforeRemoveMember: async ({ member, organization: org, user }) => {
          if (member.role.split(",").includes("owner"))
            throw new APIError("FORBIDDEN", {
              message: "Transfer ownership before removing an owner",
            });
          await activeOrg(org.id);
          await record(event(user, org.id, "org.member.remove.requested", member.id));
        },
        beforeUpdateMemberRole: async ({ member, organization: org }) => {
          if (member.role.split(",").includes("owner"))
            throw new APIError("FORBIDDEN", { message: "Use elevated ownership transfer" });
          await activeOrg(org.id);
        },
        afterUpdateMemberRole: async ({ member, organization: org, user }) => {
          await record(event(user, org.id, "org.member.role", member.id));
        },
      },
    }),
    {
      id: "organization-policy",
      endpoints: {
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
              role: z.enum(["admin", "member"]).default("member"),
            }),
          },
          async (ctx) => {
            const user = ctx.context.session.user;
            await adminMember(ctx.body.organizationId, user.id);
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
              const cached = await getAuthoritativeSessionFromCtx(ctx);
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
                .object({ organizationId: z.string().optional() })
                .passthrough()
                .parse(ctx.body ?? ctx.query ?? {});
              const orgId = body.organizationId ?? live.session.activeOrganizationId;
              if (orgId) await activeOrg(orgId);
            }),
          },
        ],
      },
    },
  ];
};
