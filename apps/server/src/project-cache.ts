import { Authorization, AuthorizationAudit, AuthorizationCeilings } from "@repo/authz";
import { CredentialResolver } from "@repo/credentials";
import { Database, InstanceSettingsRepo, schema } from "@repo/db";
import { ProjectLimits } from "@repo/projects";
import { and, eq } from "drizzle-orm";
import { Effect, Redacted } from "effect";
import { ApiError } from "./api.ts";

/** Query selectors may confirm a tenant; authenticated claims alone choose storage. */
export const authorizeProjectCache = Effect.fn("Cache.authorizeProject")(
  function* (token: string, url: URL, action: "cache:read" | "cache:write") {
    const resolver = yield* CredentialResolver;
    const credential = yield* resolver.resolve(Redacted.make(`Bearer ${token}`));

    if (credential.credentialType === "legacy") {
      const team = url.searchParams.get("teamId") ?? url.searchParams.get("slug") ?? "default";

      if (!/^[\w.-]+$/.test(team))
        return yield* new ApiError({
          status: 400,
          code: "bad_request",
          message: "Invalid legacy team",
        });
      const limits = yield* ProjectLimits;

      return { prefix: team, maxUploadBytes: limits.maxArtifactBytes, credential };
    }

    const principal = credential.principal;
    const kind = credential.credentialType;
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
      if (slug !== row.org.slug) return yield* denyTenant;
    const settings = yield* InstanceSettingsRepo;
    const ceilings = yield* AuthorizationCeilings;
    const policy = yield* settings.policy(principal.org, ceilings);
    const limits = yield* ProjectLimits;

    return {
      prefix: `${principal.org}/${principal.project}`,
      credential,
      maxUploadBytes: Math.min(
        row.project.maxArtifactBytes ?? limits.maxArtifactBytes,
        limits.maxArtifactBytes,
        policy.quotaBytes,
      ),
    };
  },
  Effect.catchTags({
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
