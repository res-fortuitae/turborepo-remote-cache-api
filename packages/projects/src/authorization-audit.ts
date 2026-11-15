import { AuditLog } from "@repo/audit";
import { AuthorizationAudit } from "@repo/authz";
import { Context, Effect, Layer } from "effect";

/** Hosts schedule delivery with their request lifetime; tests may execute it inline. */
export const AuthorizationAuditBackground = Context.Reference<
  (effect: Effect.Effect<void>) => Effect.Effect<void>
>("@repo/projects/AuthorizationAuditBackground", { defaultValue: () => (effect) => effect });

/** Bridges the policy port to the append-only audit domain without a dependency cycle. */
export const AuthorizationAuditLive = Layer.effect(
  AuthorizationAudit,
  Effect.gen(function* () {
    const audit = yield* AuditLog;
    const background = yield* AuthorizationAuditBackground;

    return {
      deny: (principal, action, resource, reason) =>
        audit
          .recordStandalone({
            scope: "org",
            orgId: resource.orgId,
            projectId: resource.projectId,
            actor:
              "userId" in principal
                ? { type: "user", id: principal.userId, display: principal.userId }
                : {
                    type: principal.kind === "apiKey" ? "apiKey" : "oidc",
                    id: principal.id,
                    display: principal.id,
                  },
            action: action.includes(":") ? action.replace(":", ".") : `project.${action}`,
            target: {
              type: resource.projectId ? "project" : "organization",
              id: resource.projectId ?? resource.orgId,
            },
            outcome: "deny",
            reason,
            ip: "",
            userAgent: "",
            requestId: crypto.randomUUID(),
            metadata: {},
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logError("Authorization denial audit failed", cause),
            ),
            background,
          ),
    } satisfies typeof AuthorizationAudit.Service;
  }),
);
