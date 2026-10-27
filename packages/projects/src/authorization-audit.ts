import { AuditLog } from "@repo/audit";
import { AuthorizationAudit } from "@repo/authz";
import { Effect, Layer } from "effect";

/** Bridges the policy port to the append-only audit domain without a dependency cycle. */
export const AuthorizationAuditLive = Layer.effect(
  AuthorizationAudit,
  Effect.gen(function* () {
    const audit = yield* AuditLog;

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
          .pipe(Effect.asVoid),
    } satisfies typeof AuthorizationAudit.Service;
  }),
);
