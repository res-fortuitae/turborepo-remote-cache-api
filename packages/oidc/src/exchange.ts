import { ExchangeRequest, type ExchangeResponse } from "@repo/api-spec";
import { AuditLog } from "@repo/audit";
import { CacheTokenSigner, DpopVerifier } from "@repo/credentials";
import { InstanceSettingsRepo, ProjectRepo, TrustPolicyRepo } from "@repo/db";
import { CanonicalOrigin, OidcAudience, type IdentityCeilings } from "@repo/deploy-config";
import { ExchangeRateLimiter as RateLimiter } from "@repo/ratelimit";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { OidcVerifier, type VerifiedOidcToken } from "./verifier.ts";
import { TrustPolicyMatcher } from "./trust-policy-matcher.ts";
import { PolicyGuardrails } from "./policy-guardrails.ts";

/** A small skew margin, never an extension past instance or policy ceilings. */
export const OIDC_EXCHANGE_MARGIN_SECONDS = 30;

export class ExchangeConfig extends Context.Service<ExchangeConfig, IdentityCeilings>()(
  "@repo/oidc/ExchangeConfig",
) {}

export const ExchangeConfigLive = Layer.succeed(ExchangeConfig, {});

export class ExchangeError extends Schema.TaggedError<ExchangeError>()("ExchangeError", {
  status: Schema.Literals([403, 429, 503]),
  reason: Schema.String,
}) {}

export interface ExchangeContext {
  readonly ip: string;
  readonly userAgent: string;
  readonly requestId: string;
  readonly dpop?: string;
}

const denied = (reason: string) => new ExchangeError({ status: 403, reason });
const unavailable = () => new ExchangeError({ status: 503, reason: "unavailable" });

const snapshot = (verified: VerifiedOidcToken | undefined): Schema.JsonObject => {
  if (!verified) return {};

  const entries = Object.entries(verified.claims).filter(
    ([key, value]) =>
      [
        "iss",
        "sub",
        "aud",
        "jti",
        "iat",
        "nbf",
        "exp",
        "repository_id",
        "repository_owner_id",
        "repository",
        "ref",
        "event_name",
        "fork",
        "job_workflow_ref",
        "environment",
        "owner_id",
        "project_id",
        "namespace_id",
        "pipeline_source",
        "oidc.circleci.com/project-id",
        "oidc.circleci.com/org-id",
        "oidc.circleci.com/vcs-origin",
        "oidc.circleci.com/vcs-ref",
        "oidc.circleci.com/ssh-rerun",
        "organization_id",
        "pipeline_id",
        "build_branch",
        "build_source",
        "workspaceUuid",
        "repositoryUuid",
        "branchName",
        "deploymentEnvironment",
        "tid",
        "oid",
      ].includes(key) && Schema.is(Schema.Json)(value),
  );

  return Schema.decodeUnknownSync(Schema.JsonObject)(Object.fromEntries(entries));
};

const makeExchange = Effect.gen(function* () {
  const verifier = yield* OidcVerifier;
  const matcher = yield* TrustPolicyMatcher;
  const guardrails = yield* PolicyGuardrails;
  const signer = yield* CacheTokenSigner;
  const dpop = yield* DpopVerifier;
  const audit = yield* AuditLog;
  const limiter = yield* RateLimiter;
  const projects = yield* ProjectRepo;
  const policies = yield* TrustPolicyRepo;
  const settings = yield* InstanceSettingsRepo;
  const ceilings = yield* ExchangeConfig;
  const audiences = yield* OidcAudience;
  const api = yield* CanonicalOrigin;

  return {
    exchange: Effect.fn("OidcExchange.exchange")(function* (
      input: unknown,
      context: ExchangeContext,
    ) {
      // All attempt state is request-local. Never audit the raw token, proof or unverified claims.
      let verified: VerifiedOidcToken | undefined;
      let tenant: { team: string; project: string } | undefined;
      let diagnostics: Schema.JsonObject = {};

      const record = (outcome: "allow" | "deny" | "error", reason?: string) =>
        audit
          .commit(
            {
              scope: tenant ? "org" : "instance",
              orgId: tenant?.team,
              projectId: tenant?.project,
              actor: {
                type: "oidc",
                id: verified?.subject ?? "anonymous",
                display: verified?.issuer ?? "Unverified OIDC",
              },
              action: "oidc.exchange",
              target: {
                type: "project",
                id: tenant?.project ?? "unknown",
              },
              outcome,
              reason,
              ip: context.ip,
              userAgent: context.userAgent,
              requestId: context.requestId,
              metadata: {
                claims: snapshot(verified),
                ...diagnostics,
              },
            },
            () => [],
          )
          .pipe(Effect.mapError(unavailable));

      const run = Effect.gen(function* () {
        if (!(yield* limiter.allow(`oidc:ip:${context.ip || "unknown"}`)))
          return yield* new ExchangeError({ status: 429, reason: "rate_limit_ip" });

        const request = yield* Schema.decodeUnknownEffect(ExchangeRequest)(input).pipe(
          Effect.mapError(() => denied("malformed")),
        );

        if (!(yield* limiter.allow(`oidc:org:${request.team}`)))
          return yield* new ExchangeError({ status: 429, reason: "rate_limit_org" });
        verified = yield* verifier
          .verify(Redacted.value(request.token))
          .pipe(
            Effect.catchTag("OidcVerificationError", (error) =>
              Effect.fail(denied(`verification_${error.reason}`)),
            ),
          );
        const project = yield* projects.find(request.team, request.project);
        const resource = yield* settings.resource(request.team, request.project);

        if (!project || !resource.exists || resource.deleted || resource.orgArchived)
          return yield* denied("resource_unavailable");
        tenant = { team: request.team, project: project.id };
        const policy = yield* settings.policy(request.team, ceilings);
        const enabled = (yield* policies.list(project.id)).filter((entry) => entry.enabled);

        const reports = enabled.map((entry) => ({
          id: entry.id,
          ...guardrails.evaluate(
            { ...entry.body, provider: entry.provider, enabled: entry.enabled },
            {
              audiences,
              allowedIssuers: policy.allowedOidcIssuers,
              maxTokenTtlSeconds: policy.maxTokenTtlSeconds,
              requireBoundTokens: policy.requireBoundTokens,
              workflowRefs: policy.oidcWriteWorkflowRefs,
              environments: policy.oidcWriteEnvironments,
            },
          ),
        }));

        const decision = matcher.match(
          project,
          enabled.filter((entry) =>
            reports.some(
              (report) =>
                report.id === entry.id &&
                // Existing policies survive a tightened lifetime ceiling; issuance clamps their TTL.
                report.errors.every((error) => error.code === "ttl_exceeds_maximum"),
            ),
          ),
          verified.claims,
        );

        diagnostics = {
          guardrails: reports.map((report) => ({
            policyId: report.id,
            errors: report.errors.map((error) => error.code),
          })),
          ...(decision.matched
            ? { policyIds: [...decision.policyIds] }
            : {
                closestPolicyId: decision.closest?.policyId ?? null,
                failedClaims: [...(decision.closest?.failedClaims ?? [])],
              }),
        };

        if (!decision.matched) return yield* denied("policy_mismatch");

        if (
          context.dpop === undefined &&
          (policy.requireBoundTokens || decision.requireBoundTokens)
        )
          return yield* denied("binding_required");
        const thumbprint =
          context.dpop === undefined
            ? undefined
            : yield* dpop
                .verify({
                  proof: context.dpop,
                  method: "POST",
                  url: `${api}/oidc/exchange`,
                })
                .pipe(
                  Effect.mapError((error) =>
                    error.reason === "unavailable" ? unavailable() : denied(`dpop_${error.reason}`),
                  ),
                );

        if (policy.requireArtifactSigning) return yield* denied("artifact_signing_unavailable");

        const ttl = Math.floor(
          Math.min(
            decision.ttlSeconds,
            policy.maxTokenTtlSeconds,
            (verified.expiresAt - (yield* Clock.currentTimeMillis)) / 1000 +
              OIDC_EXCHANGE_MARGIN_SECONDS,
          ),
        );

        if (ttl < 1) return yield* denied("expired");

        const issued = yield* signer.issue({
          subject: `oidc:${verified.issuer}:${verified.subject}`,
          org: request.team,
          project: project.id,
          scope: decision.scope,
          maxTtlSeconds: ttl,
          cnf: thumbprint === undefined ? undefined : { jkt: thumbprint },
          // Only these verified, bounded claims enter artifact incident-response metadata.
          uploadIdentity: {
            provider: verified.issuer.length <= 128 ? verified.issuer : undefined,
            repositoryId:
              typeof verified.claims.repository_id === "string" &&
              verified.claims.repository_id.length <= 128
                ? verified.claims.repository_id
                : undefined,
            ref:
              typeof verified.claims.ref === "string" && verified.claims.ref.length <= 128
                ? verified.claims.ref
                : undefined,
            jobWorkflowRef:
              typeof verified.claims.job_workflow_ref === "string" &&
              verified.claims.job_workflow_ref.length <= 128
                ? verified.claims.job_workflow_ref
                : undefined,
            commitSha:
              typeof verified.claims.sha === "string" && verified.claims.sha.length <= 128
                ? verified.claims.sha
                : undefined,
            runId:
              typeof verified.claims.run_id === "string" && verified.claims.run_id.length <= 128
                ? verified.claims.run_id
                : undefined,
          },
        });

        diagnostics = {
          ...diagnostics,
          bound: thumbprint !== undefined,
          scope: decision.scope,
          expiresAt: issued.principal.expiresAt * 1000,
          cacheTokenId: issued.principal.tokenId,
        };

        return {
          token: Redacted.make(issued.token),
          expiresAt: new Date(issued.principal.expiresAt * 1000).toISOString(),
          api,
          team: request.team,
          project: project.id,
          scope: decision.scope,
        } satisfies ExchangeResponse;
      }).pipe(Effect.mapError((error) => (error instanceof ExchangeError ? error : unavailable())));

      return yield* run.pipe(
        Effect.tapError((error) => record(error.status === 503 ? "error" : "deny", error.reason)),
        Effect.tap(() => record("allow")),
      );
    }),
  };
});

export class OidcExchange extends Context.Service<
  OidcExchange,
  Effect.Success<typeof makeExchange>
>()("@repo/oidc/OidcExchange") {}

export const OidcExchangeLive = Layer.effect(OidcExchange, makeExchange);
