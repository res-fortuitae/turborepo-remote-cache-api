import { passkey } from "@better-auth/passkey";
import type { AuditLogService } from "@repo/audit";
import { schema, type DatabaseDrizzle } from "@repo/db";
import type { AuthSettings } from "@repo/deploy-config";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { readInstancePolicy } from "./instance.ts";
import { requirePasskeyProof } from "./passkey-proof.ts";

export const passkeyPlugins = (
  db: DatabaseDrizzle,
  config: AuthSettings,
  audit?: AuditLogService,
) => {
  const verified = new WeakMap<object, { userId: string; sourceSessionId: string; at: number }>();

  const requireAdmin = createAuthMiddleware(async (ctx) => {
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

    if (
      !live ||
      live.user.banned ||
      live.session.impersonatedBy ||
      !["owner", "admin"].includes(live.user.role ?? "")
    )
      throw new APIError("FORBIDDEN");
    const registration = ctx.path.includes("registration") || ctx.path.includes("register");
    const management = ["/passkey/delete-passkey", "/passkey/update-passkey"].includes(ctx.path);

    if ((registration && ctx.path === "/passkey/verify-registration") || management) {
      if (!audit) throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit unavailable" });
      await Effect.runPromise(
        audit.commit(
          {
            scope: "instance",
            actor: { type: "user", id: live.user.id, display: live.user.name },
            action: `instance${ctx.path.replaceAll("/", ".")}.requested`,
            target: { type: "user", id: live.user.id },
            outcome: "allow",
            ip: "",
            userAgent: "",
            requestId: crypto.randomUUID(),
            metadata: {},
          },
          () => [],
        ),
      );
    }

    if (registration || management) {
      const policy = await readInstancePolicy(db, config);

      const [existing] = await db
        .select()
        .from(schema.passkey)
        .where(eq(schema.passkey.userId, live.user.id))
        .limit(1);

      if (ctx.path === "/passkey/delete-passkey" && policy.requirePasskeyForAdmins) {
        const keys = await db
          .select()
          .from(schema.passkey)
          .where(eq(schema.passkey.userId, live.user.id));

        if (keys.length <= 1)
          throw new APIError("FORBIDDEN", { message: "Cannot remove the last required passkey" });
      }

      if (policy.requirePasskeyForAdmins || existing)
        await requirePasskeyProof(db, live.session.id, live.user.id);
      else if (Date.now() - live.session.createdAt.getTime() > 600000)
        throw new APIError("FORBIDDEN", {
          message: "Sign in again before enrolling your first passkey",
        });
    }
  });

  const origin = config.baseURL === undefined ? undefined : new URL(config.baseURL).origin;

  return [
    passkey({
      rpID: origin === undefined ? "localhost" : new URL(origin).hostname,
      rpName: "Turborepo Remote Cache",
      origin,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      registration: {
        requireSession: true,
        afterVerification: async ({ verification }) => {
          if (!verification.registrationInfo?.userVerified)
            throw new APIError("FORBIDDEN", { message: "Passkey user verification is required" });
        },
      },
      authentication: {
        afterVerification: async ({ ctx, verification, clientData }) => {
          if (!verification.authenticationInfo.userVerified)
            throw new APIError("FORBIDDEN", { message: "Passkey user verification is required" });
          const current = await getAuthoritativeSessionFromCtx(ctx);

          const [credential] = await db
            .select()
            .from(schema.passkey)
            .where(eq(schema.passkey.credentialID, clientData.id));

          if (!current || credential?.userId !== current.user.id)
            throw new APIError("FORBIDDEN", {
              message: "Passkey must belong to the signed-in administrator",
            });
          verified.set(ctx.context, {
            userId: current.user.id,
            sourceSessionId: current.session.id,
            at: Date.now(),
          });
        },
      },
    }),
    {
      id: "admin-passkey-policy",
      hooks: {
        before: [
          {
            matcher: (ctx: { path?: string }) => ctx.path?.startsWith("/passkey/") === true,
            handler: requireAdmin,
          },
        ],
        after: [
          {
            matcher: (ctx: { path?: string }) => ctx.path === "/passkey/verify-authentication",
            handler: createAuthMiddleware(async (ctx) => {
              const proof = verified.get(ctx.context);
              verified.delete(ctx.context);
              const session = ctx.context.newSession;

              if (!proof || !session || proof.userId !== session.user.id) return;

              if (!audit)
                throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit unavailable" });
              await Effect.runPromise(
                audit.commit(
                  {
                    scope: "instance",
                    actor: { type: "user", id: session.user.id, display: session.user.name },
                    action: "instance.passkey.verified",
                    target: { type: "session", id: session.session.id },
                    outcome: "allow",
                    ip: "",
                    userAgent: "",
                    requestId: crypto.randomUUID(),
                    metadata: {},
                  },
                  (db) => [
                    db
                      .insert(schema.passkeyProof)
                      .values({
                        sessionId: session.session.id,
                        userId: session.user.id,
                        verifiedAt: proof.at,
                      })
                      .onConflictDoUpdate({
                        target: schema.passkeyProof.sessionId,
                        set: { verifiedAt: proof.at },
                      }),
                    db.delete(schema.session).where(eq(schema.session.id, proof.sourceSessionId)),
                    db
                      .delete(schema.passkeyProof)
                      .where(eq(schema.passkeyProof.sessionId, proof.sourceSessionId)),
                  ],
                ),
              );
            }),
          },
        ],
      },
    },
  ];
};
