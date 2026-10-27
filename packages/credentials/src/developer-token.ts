import { DeveloperTokenRequest, type ExchangeResponse } from "@repo/api-spec";
import { AuditLog } from "@repo/audit";
import { Auth } from "@repo/auth";
import { Authorization, AuthorizationCeilings } from "@repo/authz";
import { InstanceSettingsRepo, ProjectRepo } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { RateLimiter } from "@repo/ratelimit";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { ArtifactSigning } from "./artifact-signing.ts";
import { CacheTokenSigner } from "./cache-token.ts";

export class DeveloperTokenError extends Schema.TaggedError<DeveloperTokenError>()(
  "DeveloperTokenError",
  {
    status: Schema.Number,
    code: Schema.String,
  },
) {}
const denied = () => new DeveloperTokenError({ status: 403, code: "forbidden" });
const make = Effect.gen(function* () {
  const auth = yield* Auth;
  const authorization = yield* Authorization;
  const signer = yield* CacheTokenSigner;
  const settings = yield* InstanceSettingsRepo;
  const projects = yield* ProjectRepo;
  const ceilings = yield* AuthorizationCeilings;
  const audit = yield* AuditLog;
  const limiter = yield* RateLimiter;
  const api = yield* CanonicalOrigin;
  const artifactSigning = yield* Effect.serviceOption(ArtifactSigning);
  return {
    issue: Effect.fn("DeveloperTokens.issue")(function* (
      input: unknown,
      headers: Headers,
    ): Effect.fn.Return<ExchangeResponse, DeveloperTokenError> {
      const execute = Effect.gen(function* () {
        yield* limiter.check(headers.get("cf-connecting-ip") ?? "unknown", {
          name: "developer-token",
          limit: 30,
          period: 60,
        });
        if (headers.get("origin") !== api) return yield* denied();
        const session = yield* auth.requireFreshSession(headers);
        if (session.session.impersonatedBy) return yield* denied();
        const request = yield* Schema.decodeUnknownEffect(DeveloperTokenRequest)(input).pipe(
          Effect.mapError(() => new DeveloperTokenError({ status: 400, code: "bad_request" })),
        );
        const project = yield* projects.find(request.team, request.project);
        if (!project) return yield* denied();
        const policy = yield* settings.policy(request.team, ceilings);
        const resource = { orgId: request.team, projectId: project.id };
        const principal = { userId: session.user.id, sessionId: session.session.id };
        yield* authorization.require(principal, "cache:read", resource);
        const scope = request.write === true ? ("read write" as const) : ("read" as const);
        if (request.write) {
          if (policy.developerCacheWrites !== true) return yield* denied();
          yield* authorization.require(principal, "cache:write", resource);
        }
        if (policy.requireBoundTokens) return yield* denied();
        const signing =
          artifactSigning._tag === "Some"
            ? yield* artifactSigning.value.deliver(request.team, project.id, {
                scope: "org",
                orgId: request.team,
                projectId: project.id,
                actor: { type: "user", id: session.user.id, display: session.user.name },
                action: "artifact.signing.access",
                target: { type: "project", id: project.id },
                outcome: "allow",
                ip: headers.get("cf-connecting-ip") ?? "",
                userAgent: headers.get("user-agent") ?? "",
                requestId: crypto.randomUUID(),
                metadata: {},
              })
            : undefined;
        if (policy.requireArtifactSigning && !signing) return yield* denied();
        const now = yield* Clock.currentTimeMillis;
        const ttl = Math.min(
          request.ttlSeconds ?? 3600,
          43200,
          policy.maxTokenTtlSeconds,
          Math.floor((session.session.expiresAt.getTime() - now) / 1000),
        );
        if (ttl <= 0) return yield* denied();
        const issued = yield* signer.issue({
          subject: `user:${session.user.id}`,
          org: request.team,
          project: project.id,
          scope,
          maxTtlSeconds: ttl,
        });
        yield* audit.commit(
          {
            scope: "org",
            orgId: request.team,
            projectId: project.id,
            actor: { type: "user", id: session.user.id, display: session.user.name },
            action: "token.developer.issue",
            target: { type: "token", id: issued.principal.tokenId },
            outcome: "allow",
            ip: headers.get("cf-connecting-ip") ?? "",
            userAgent: headers.get("user-agent") ?? "",
            requestId: crypto.randomUUID(),
            metadata: { scope, expiresAt: issued.principal.expiresAt },
          },
          () => [],
        );
        return {
          api,
          team: request.team,
          project: project.id,
          token: Redacted.make(issued.token),
          scope,
          ...signing,
          expiresAt: new Date(issued.principal.expiresAt * 1000).toISOString(),
        };
      });
      return yield* execute.pipe(
        Effect.mapError((error) => {
          if (error._tag === "DeveloperTokenError") return error;
          if (error._tag === "Unauthenticated")
            return new DeveloperTokenError({ status: 401, code: "unauthenticated" });
          if (error._tag === "RateLimited")
            return new DeveloperTokenError({ status: 429, code: "rate_limited" });
          if (error._tag === "AuthzError") return denied();
          return new DeveloperTokenError({ status: 503, code: "unavailable" });
        }),
      );
    }),
  };
});
export class DeveloperTokens extends Context.Service<
  DeveloperTokens,
  Effect.Success<typeof make>
>()("@repo/credentials/DeveloperTokens") {}
export const DeveloperTokensLive = Layer.effect(DeveloperTokens, make);
