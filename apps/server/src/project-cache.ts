import { Authorization, AuthorizationAudit, AuthorizationCeilings } from "@repo/authz";
import { CacheTokenVerifier, DpopVerifier, DpopInvalid } from "@repo/credentials";
import { Database, InstanceSettingsRepo, schema } from "@repo/db";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Redacted } from "effect";
import { ProjectLimits } from "@repo/projects";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
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
      readonly proofAlreadyVerified?: boolean;
    },
  ) {
    const verifier = yield* CacheTokenVerifier;
    const principal = yield* verifier.verify(token);

    if (principal.cnf !== undefined) {
      if (!request?.dpop || request.scheme !== "dpop")
        return yield* new DpopInvalid({ reason: "binding" });
      const dpop = yield* DpopVerifier;
      const origin = yield* CanonicalOrigin;

      // The API repeats live authorization after streaming PUT. Claim the proof only once per request.
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
    const authorization = yield* Authorization;
    yield* authorization.require(
      {
        kind: "cacheJwt",
        id: principal.tokenId,
        orgId: principal.org,
        projectId: principal.project,
        scope: principal.scope,
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
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
            kind: "cacheJwt",
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
      if (slug !== row.org.slug) return yield* denyTenant;
    const settings = yield* InstanceSettingsRepo;
    const ceilings = yield* AuthorizationCeilings;
    const policy = yield* settings.policy(principal.org, ceilings);

    if (policy.requireBoundTokens && principal.cnf === undefined)
      return yield* new DpopInvalid({ reason: "binding" });
    const limits = yield* ProjectLimits;

    return {
      prefix: `${principal.org}/${principal.project}`,
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
    CacheTokenInvalid: () =>
      Effect.fail(
        new ApiError({ status: 403, code: "forbidden", message: "Invalid cache credential" }),
      ),
    CacheTokenRevoked: () =>
      Effect.fail(
        new ApiError({ status: 403, code: "forbidden", message: "Revoked cache credential" }),
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
