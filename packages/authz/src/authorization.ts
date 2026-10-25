import { Forbidden } from "@repo/api-spec";
import { hasOrganizationPermission } from "@repo/auth";
import { Database, schema } from "@repo/db";
import { and, eq, gt } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";

export interface SessionPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

export type ProjectAction = "create" | "read" | "update" | "delete";

/** Session/org decisions for project management. Project grants follow in STV-439/440. */
const authorization = Effect.gen(function* () {
  const database = yield* Database;

  const can = Effect.fn("Authorization.can")(function* (
    principal: SessionPrincipal,
    action: ProjectAction,
    resource: { readonly orgId: string },
  ) {
    const now = yield* Clock.currentTimeMillis;

    const [live] = yield* database.query("Authorization.session", (db) =>
      db
        .select({ user: schema.user, session: schema.session })
        .from(schema.session)
        .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
        .where(
          and(
            eq(schema.session.id, principal.sessionId),
            eq(schema.session.userId, principal.userId),
            gt(schema.session.expiresAt, new Date(now)),
          ),
        ),
    );

    if (!live || live.user.banned || live.session.impersonatedBy) return false;

    const [org] = yield* database.query("Authorization.organization", (db) =>
      db.select().from(schema.organization).where(eq(schema.organization.id, resource.orgId)),
    );

    if (!org) return false;

    const [lifecycle] = yield* database.query("Authorization.lifecycle", (db) =>
      db.select().from(schema.orgLifecycle).where(eq(schema.orgLifecycle.orgId, resource.orgId)),
    );

    if (action !== "read" && lifecycle?.archivedAt != null) return false;

    if (live.user.role === "owner" || live.user.role === "admin") {
      const [elevation] = yield* database.query("Authorization.elevation", (db) =>
        db
          .select()
          .from(schema.orgElevation)
          .where(
            and(
              eq(schema.orgElevation.orgId, resource.orgId),
              eq(schema.orgElevation.userId, principal.userId),
              eq(schema.orgElevation.sessionId, principal.sessionId),
              gt(schema.orgElevation.expiresAt, now),
            ),
          ),
      );

      if (elevation) return true;
    }

    return yield* database.query("Authorization.organizationPermission", () =>
      hasOrganizationPermission(
        database.drizzle,
        resource.orgId,
        principal.userId,
        "project",
        action,
      ),
    );
  });

  return {
    can,
    require: Effect.fn("Authorization.require")(function* (
      principal: SessionPrincipal,
      action: ProjectAction,
      resource: { readonly orgId: string },
    ) {
      if (!(yield* can(principal, action, resource)))
        return yield* new Forbidden({ message: "Project permission denied" });
    }),
  };
});

export class Authorization extends Context.Service<
  Authorization,
  Effect.Success<typeof authorization>
>()("@repo/authz/Authorization") {}

export const AuthorizationLive = Layer.effect(Authorization, authorization);
