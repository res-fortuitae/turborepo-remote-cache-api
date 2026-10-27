import type { AuditLogService } from "@repo/audit";
import { schema, type DatabaseDrizzle } from "@repo/db";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import {
  deviceAuthorization,
  type DeviceAuthorizationGrant,
} from "better-auth/plugins/device-authorization";
import { and, eq, gt, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { z } from "zod";

/** First-party public client. Device codes always use the database adapter, never KV. */
export const devicePlugins = (db: DatabaseDrizzle, audit?: AuditLogService) => {
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
  const decide = (status: "approved" | "denied") =>
    createAuthEndpoint(
      status === "approved" ? "/device/approve" : "/device/deny",
      {
        method: "POST",
        requireHeaders: true,
        use: [fresh],
        body: z.object({ userCode: z.string().min(1).max(32) }),
      },
      async (ctx) => {
        const userCode = ctx.body.userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        const [code] = await db
          .select()
          .from(schema.deviceCode)
          .where(
            and(
              eq(schema.deviceCode.userCode, userCode),
              eq(schema.deviceCode.userId, ctx.context.session.user.id),
              eq(schema.deviceCode.status, "pending"),
              gt(schema.deviceCode.expiresAt, new Date()),
            ),
          );
        if (!code)
          throw new APIError("BAD_REQUEST", { message: "Invalid or expired device request" });
        if (!audit) throw new APIError("SERVICE_UNAVAILABLE");
        // The predicate is repeated in the atomic batch. Concurrent/replayed decisions cannot change it.
        await Effect.runPromise(
          audit.commit(
            {
              scope: "instance",
              actor: {
                type: "user",
                id: ctx.context.session.user.id,
                display: ctx.context.session.user.name,
              },
              action: `device.${status}`,
              target: { type: "device", id: code.id },
              outcome: status === "approved" ? "allow" : "deny",
              ip: ctx.headers?.get("cf-connecting-ip") ?? "",
              userAgent: ctx.headers?.get("user-agent") ?? "",
              requestId: crypto.randomUUID(),
              metadata: { clientId: "tcache", requestIp: code.requestIp ?? "unknown" },
            },
            (db) => [
              db
                .update(schema.deviceCode)
                .set({
                  // NOT NULL rejects a lost decision race and rolls back its audit event.
                  status: sql`case when ${schema.deviceCode.status} = 'pending' and ${schema.deviceCode.expiresAt} > ${Date.now()} then ${status} else null end`,
                })
                .where(eq(schema.deviceCode.id, code.id)),
            ],
          ),
        );
        return ctx.json({ success: true });
      },
    );
  const plugin = deviceAuthorization<DeviceAuthorizationGrant>({
    expiresIn: "5m",
    interval: "5s",
    verificationUri: "/?view=device",
    validateClient: (id) => id === "tcache",
    grant: {
      requestSchemaFields: {},
      deviceCodeSchemaFields: { requestIp: { type: "string", required: false } },
      authorizeRequest: ({ ctx, request }) => {
        if (
          request.client_id !== "tcache" ||
          request.user_id ||
          (request.scope && request.scope !== "developer")
        )
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "Unsupported device request",
          });
        return {
          clientId: "tcache",
          deviceCodeFields: { requestIp: ctx.headers?.get("cf-connecting-ip") ?? "unknown" },
        };
      },
      assertSessionRedemption: () => {},
      getVerificationContext: (code) => ({
        request_ip: typeof code.requestIp === "string" ? code.requestIp : "unknown",
        client_name: "tcache CLI",
      }),
    },
  });
  return [
    {
      ...plugin,
      rateLimit: [{ pathMatcher: (path: string) => path === "/device", window: 60, max: 5 }],
      endpoints: {
        ...plugin.endpoints,
        deviceApprove: decide("approved"),
        deviceDeny: decide("denied"),
      },
    },
    {
      id: "device-policy",
      hooks: {
        before: [
          {
            matcher: (ctx: { path?: string }) => ctx.path === "/device",
            handler: createAuthMiddleware(async (ctx) => {
              await fresh(ctx);
            }),
          },
        ],
      },
      rateLimit: [
        { pathMatcher: (path: string) => path.startsWith("/device/"), window: 60, max: 20 },
      ],
    },
  ];
};
