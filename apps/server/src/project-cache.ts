import { CoordinatorClient } from "@repo/coordinator/client";
import { Authorization, AuthorizationAudit, AuthorizationCeilings } from "@repo/authz";
import { CredentialResolver, DpopVerifier, DpopInvalid } from "@repo/credentials";
import { Database, InstanceSettingsRepo, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { ProjectLimits } from "@repo/projects";
import { and, eq } from "drizzle-orm";
import { Effect, Redacted } from "effect";
import { ApiError } from "./api.ts";

/** Query selectors may confirm a tenant; authenticated claims alone choose storage. */
export const authorizeProjectCache = Effect.fn("Cache.authorizeProject")(
  function* (
    token: string,
    url: URL,
    action: "cache:read" | "cache:write",
    request?: {
      readonly method: string;
      readonly dpop?: string;
      readonly scheme: string;
      readonly artifactTag?: string;
      readonly proofAlreadyVerified?: boolean;
    },
  ) {
    const resolver = yield* CredentialResolver;
    const credential = yield* resolver.resolve(Redacted.make(`Bearer ${token}`));

    if (credential.credentialType === "legacy") {
      if (request?.scheme === "dpop" || request?.dpop)
        return yield* new DpopInvalid({ reason: "binding" });
      const team = url.searchParams.get("teamId") ?? url.searchParams.get("slug") ?? "default";

      if (!/^[\w.-]+$/.test(team))
        return yield* new ApiError({
          status: 400,
          code: "bad_request",
          message: "Invalid legacy team",
        });
      const legacyPolicy = yield* (yield* InstanceSettingsRepo).policy(
        "",
        yield* AuthorizationCeilings,
      );
      if (
        action === "cache:write" &&
        legacyPolicy.requireArtifactSigning &&
        !/^[A-Za-z0-9+/]{43}=$/.test(request?.artifactTag ?? "")
      )
        return yield* new ApiError({
          status: 403,
          code: "signature_required",
          message: "Artifact signature tag required",
        });
      const limits = yield* ProjectLimits;

      return { prefix: team, maxUploadBytes: limits.maxArtifactBytes, credential };
    }

    const principal = credential.principal;
    const kind = credential.credentialType;
    if (principal.cnf !== undefined) {
      if (!request?.dpop || request.scheme !== "dpop")
        return yield* new DpopInvalid({ reason: "binding" });
      const dpop = yield* DpopVerifier;
      const origin = yield* CanonicalOrigin;
      // Only the post-stream recheck inside this request skips the already claimed proof.
      if (!request.proofAlreadyVerified)
        yield* dpop.verify({
          proof: request.dpop,
          method: request.method,
          url: new URL(url.pathname + url.search, origin).href,
          thumbprint: principal.cnf.jkt,
          accessToken: Redacted.make(token),
        });
    } else if (request?.dpop || request?.scheme === "dpop")
      return yield* new DpopInvalid({ reason: "binding" });
    const signatureTag = request?.artifactTag;
    const multipartContinuation = /^\/v8\/x\/uploads\/[^/]+\//.test(url.pathname);
    const signed =
      multipartContinuation ||
      (typeof signatureTag === "string" && /^[A-Za-z0-9+/]{43}=$/.test(signatureTag));
    const authorization = yield* Authorization;
    yield* authorization.require(
      {
        kind,
        id: principal.tokenId,
        orgId: principal.org,
        projectId: principal.project,
        scope: principal.scope,
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
        signed,
        bound: principal.cnf !== undefined,
      },
      action,
      { orgId: principal.org, projectId: principal.project },
    );
    const database = yield* Database;

    const [row] = yield* database.query("Cache.project", (db) =>
      db
        .select({
          project: schema.project,
          org: schema.organization,
        })
        .from(schema.project)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.project.orgId))
        .where(
          and(eq(schema.project.id, principal.project), eq(schema.project.orgId, principal.org)),
        ),
    );

    if (!row)
      return yield* new ApiError({
        status: 403,
        code: "forbidden",
        message: "Project unavailable",
      });

    const denyTenant = Effect.gen(function* () {
      const audit = yield* AuthorizationAudit;
      yield* audit
        .deny(
          {
            kind,
            id: principal.tokenId,
            orgId: principal.org,
            projectId: principal.project,
            scope: principal.scope,
            issuedAt: principal.issuedAt,
            expiresAt: principal.expiresAt,
          },
          action,
          { orgId: principal.org, projectId: principal.project },
          "credential_tenant",
        )
        .pipe(
          Effect.mapError(
            () =>
              new ApiError({
                status: 500,
                code: "unavailable",
                message: "Authorization audit unavailable",
              }),
          ),
        );

      return yield* new ApiError({
        status: 403,
        code: "forbidden",
        message: "Credential tenant mismatch",
      });
    });

    for (const team of url.searchParams.getAll("teamId"))
      if (team !== principal.org) return yield* denyTenant;

    for (const slug of url.searchParams.getAll("slug"))
      if (slug !== row.org.slug && slug !== principal.org) return yield* denyTenant;
    const settings = yield* InstanceSettingsRepo;
    const ceilings = yield* AuthorizationCeilings;
    const policy = yield* settings.policy(principal.org, ceilings);
    if (policy.requireBoundTokens && principal.cnf === undefined)
      return yield* new DpopInvalid({ reason: "binding" });
    const [signing] = yield* database.query("Cache.signing", (db) =>
      db
        .select()
        .from(schema.artifactSigningSettings)
        .where(eq(schema.artifactSigningSettings.projectId, principal.project)),
    );
    const requireArtifactSigning = policy.requireArtifactSigning || signing?.required === true;
    if (action === "cache:write" && requireArtifactSigning && !signed)
      return yield* new ApiError({
        status: 403,
        code: "signature_required",
        message: "Artifact signature tag required",
      });
    const limits = yield* ProjectLimits;

    return {
      requireArtifactSigning,
      prefix: `${principal.org}/${principal.project}`,
      cacheGeneration: yield* CoordinatorClient.use((client) =>
        client.cacheGeneration(principal.project, action === "cache:write"),
      ),
      credential,
      maxQueryHashes: policy.maxQueryHashes ?? 100,
      requestsPerMinute: policy.cacheRequestsPerMinute ?? 600,
      maxUploadBytes: Math.min(
        row.project.maxArtifactBytes ?? limits.maxArtifactBytes,
        limits.maxArtifactBytes,
        policy.quotaBytes,
      ),
    };
  },
  Effect.catchTags({
    DpopInvalid: (error) =>
      Effect.fail(
        new ApiError({
          status: error.reason === "unavailable" ? 503 : 403,
          code: "forbidden",
          message: "Cache proof rejected",
        }),
      ),
    CredentialInvalid: () =>
      Effect.fail(
        new ApiError({ status: 401, code: "unauthorized", message: "Invalid cache credential" }),
      ),
    AuthzError: (error) =>
      Effect.fail(
        new ApiError({
          status: error.reason === "unavailable" ? 500 : 403,
          code: error.reason,
          message: "Cache access denied",
        }),
      ),
  }),
  Effect.mapError((error) =>
    error instanceof ApiError
      ? error
      : new ApiError({
          status: 500,
          code: "unavailable",
          message: "Cache authorization unavailable",
        }),
  ),
);
