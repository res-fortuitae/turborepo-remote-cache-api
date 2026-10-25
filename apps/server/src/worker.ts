import { PolicyGuardrailsLive } from "@repo/oidc";
import { MultipartUploadsLive, MultipartBucket, MultipartSecret } from "@repo/artifacts";
import { multipartRoute } from "./multipart-route.ts";
import { MULTIPART_PART_BYTES, MAX_MULTIPART_PARTS } from "@repo/api-spec";
import { makeMultipartBucket } from "./multipart-bucket.ts";
import { uploadChunked } from "./chunked-upload.ts";

import { and, eq } from "drizzle-orm";
import {
  IncidentPurge,
  IncidentPurgeLive,
  PurgeInventory,
  ArtifactPurger,
  PurgeError,
} from "@repo/artifacts";
import { PurgeJobsLive } from "./purge-jobs.ts";
import { purgeRoute, purgePath } from "./purge-route.ts";
import { RateLimiterLive, RateLimitBinding } from "@repo/ratelimit";
import {
  cacheCredentialGuard,
  cacheAuthenticationFailureGuard,
  oidcExchangeGuard,
} from "./request-guards.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { type RuntimeContext, AlchemyContext } from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
  AuditIntegrityLive,
  AuditRetention,
  AuditLog,
  AuditLogLive,
  AuditLogD1Only,
  CheckpointStore,
  dailyAuditJob,
  drainOutboxJob,
  makeAuditSink,
  makeCheckpointStore,
} from "@repo/audit";
import {
  AlertsLive,
  NotificationSink,
  MailerError,
  EmailSend,
  MailerLive,
  MailerDisabled,
  MailerConsole,
} from "@repo/mailer";
import {
  apiKeyDigestJob,
  ApiKeyEpochs,
  ApiKeyBackground,
  AuthKvNamespace,
  AuthLive,
  SecondaryStorageLive,
} from "@repo/auth";
import {
  CoordinatorClient,
  CoordinatorClientLive,
  CoordinatorNamespace,
  makeCoordinatorNamespace,
  Coordinator,
  CoordinatorLive,
} from "@repo/coordinator";
import {
  D1Client,
  Database as DatabaseService,
  schema,
  DatabaseLive,
  ReplayGuardLive,
  ProjectRepoLive,
  InstanceSettingsRepoLive,
} from "@repo/db";
import { AuthorizationDatabaseLive, AuthorizationCeilings } from "@repo/authz";
import {
  ProjectLimits,
  ProjectsLive,
  AuthorizationAuditLive,
  ProjectMaintenance,
  ProjectMaintenanceLive,
  ProjectStorage,
  ProjectRetentionRules,
} from "@repo/projects";
import { isProjectsPath, projectsRoute } from "./projects-route.ts";
import { pruneOidcReplayIds } from "@repo/oidc";
import {
  AuthConfig,
  IdentityCeilings,
  CanonicalOrigin,
  OidcAudience,
  OidcAudiences,
  resolveOriginSettings,
} from "@repo/deploy-config";
import { ArtifactOpEmitter, ArtifactOpEmitterD1Uploads, AnalyticsEmitter } from "@repo/analytics";
import { Capabilities, DeploymentCapabilities, capabilityLayers } from "./capabilities.ts";
import { capabilitiesRoute } from "./capabilities-route.ts";
import { CapabilityReport } from "@repo/shared";
import {
  ArtifactBucket,
  AuditBasin,
  AuditCheckpointBucket,
  BasinSqlToken,
  BetterAuthSecret,
  CacheNamespace,
  DashboardAssets,
  Database,
  GitHubOAuthSecret,
  RequestRateLimits,
  SigningKey,
  R2LifecycleToken,
  TransactionalEmail,
} from "@repo/infra";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { makeRetentionRules } from "./retention-rules.ts";
import { authorizeProjectCache } from "./project-cache.ts";
import {
  ApiKeyVerifierLive,
  CredentialResolverLive,
  LegacyCredentialConfig,
  CacheTokenVerifierLive,
  CacheTokenConfigLive,
  KeyStoreLive,
  SigningKeySecret,
} from "@repo/credentials";
import { ApiError, artifactApi } from "./api.ts";
import { authRoute, isAuthPath } from "./auth.ts";
import { workerDomain } from "./deploy-config.ts";
import { loadDeployConfig } from "../scripts/config.ts";
import { resolveDeployment, validateGitHubOAuth } from "./deployment.ts";
import * as EdgeCache from "./edge-cache.ts";
import { withSecurityHeaders } from "./security-headers.ts";

const AuthEnvironment = Schema.Struct({
  MAX_ARTIFACT_BYTES: Schema.optional(Schema.NumberFromString),
  MAX_DIRECT_UPLOAD_BYTES: Schema.optional(Schema.NumberFromString),
  RATE_LIMIT_STAGE: Schema.optional(Schema.String),
  LEGACY_TOKEN_ENABLED: Schema.optional(Schema.String),
  R2_LIFECYCLE_ACCOUNT_ID: Schema.optional(Schema.String),
  R2_LIFECYCLE_BUCKET: Schema.optional(Schema.String),
  R2_LIFECYCLE_JURISDICTION: Schema.optional(Schema.String),
  PROJECT_RETENTION_DAYS: Schema.optional(Schema.NumberFromString),
  OIDC_AUDIENCES: Schema.optional(Schema.fromJsonString(OidcAudiences)),
  CAPABILITIES: Schema.optional(Schema.fromJsonString(CapabilityReport)),
  GITHUB_CLIENT_ID: Schema.optional(Schema.NonEmptyString),
  GROUP_LIMITS: Schema.optional(
    Schema.fromJsonString(Schema.Struct({ maxGroups: Schema.Int, maxMembersPerGroup: Schema.Int })),
  ),
  EMAIL_FROM: Schema.optional(Schema.String),
  IDENTITY_CEILINGS: Schema.optional(Schema.fromJsonString(IdentityCeilings)),
});

interface DeploymentEnvironment {
  MAX_ARTIFACT_BYTES: string;
  MAX_DIRECT_UPLOAD_BYTES: string;
  RATE_LIMIT_STAGE: string;
  LEGACY_TOKEN_ENABLED: string;
  R2_LIFECYCLE_ACCOUNT_ID?: string;
  R2_LIFECYCLE_BUCKET?: string;
  R2_LIFECYCLE_JURISDICTION?: string;
  PROJECT_RETENTION_DAYS: string;
  EDGE_CACHE_ENABLED: string;
  CAPABILITIES: string;
  OIDC_AUDIENCES?: string;
  GITHUB_CLIENT_ID?: string;
  IDENTITY_CEILINGS?: string;
  EMAIL_FROM?: string;
  GROUP_LIMITS?: string;
}

const decodeAuthEnvironment = Schema.decodeUnknownEffect(AuthEnvironment);

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    // Deployment config is local to the operator and absent from the Worker.
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };

    const config = yield* Effect.promise(() => loadDeployConfig());
    const { dev } = yield* AlchemyContext;
    const stage = yield* Stage;
    const domain = dev ? undefined : workerDomain(config, stage);

    const capabilities = yield* DeploymentCapabilities;

    if (capabilities === undefined)
      return yield* Effect.die(
        new Error("Deployment capabilities must be resolved by alchemy.run.ts"),
      );

    const githubOAuthSecret = yield* Config.option(
      Config.Redacted("GITHUB_OAUTH_CLIENT_SECRET"),
    ).pipe(Effect.orDie);

    validateGitHubOAuth(
      config,
      Option.isSome(githubOAuthSecret) && Redacted.value(githubOAuthSecret.value).length > 0,
    );

    const env: DeploymentEnvironment = {
      MAX_ARTIFACT_BYTES: String(config.limits.maxArtifactBytes ?? 10_000_000_000),
      MAX_DIRECT_UPLOAD_BYTES: String(
        Math.min(
          config.limits.maxDirectUploadBytes ?? Number.MAX_SAFE_INTEGER,
          capabilities.directUploads.enabled ? 200_000_000 : 100_000_000,
        ),
      ),
      RATE_LIMIT_STAGE: stage,
      LEGACY_TOKEN_ENABLED: String(config.features.legacyToken === true),
      PROJECT_RETENTION_DAYS: String(config.limits.artifactRetentionDays),
      IDENTITY_CEILINGS: JSON.stringify(config.identityCeilings ?? {}),
      EDGE_CACHE_ENABLED: String(resolveDeployment(config).edgeCacheEnabled),
      CAPABILITIES: JSON.stringify(capabilities),
    };

    const lifecycleAccount = yield* Config.option(Config.String("R2_LIFECYCLE_ACCOUNT_ID")).pipe(
      Effect.orDie,
    );

    const lifecycleBucket = yield* Config.option(Config.String("R2_LIFECYCLE_BUCKET")).pipe(
      Effect.orDie,
    );

    if (Option.isSome(lifecycleAccount) && Option.isSome(lifecycleBucket)) {
      env.R2_LIFECYCLE_ACCOUNT_ID = lifecycleAccount.value;
      env.R2_LIFECYCLE_BUCKET = lifecycleBucket.value;
      env.R2_LIFECYCLE_JURISDICTION = config.jurisdiction ?? "default";
    }

    if (config.groups !== undefined) env.GROUP_LIMITS = JSON.stringify(config.groups);

    if (config.email !== undefined) env.EMAIL_FROM = config.email.from;

    if (config.oidcAudiences !== undefined)
      env.OIDC_AUDIENCES = JSON.stringify(config.oidcAudiences);

    if (config.githubApp !== undefined) env.GITHUB_CLIENT_ID = config.githubApp.clientId;

    return {
      main: import.meta.url,
      assets: DashboardAssets,
      domain,
      // Better Auth uses AsyncLocalStorage from node:async_hooks.
      compatibility: { flags: ["nodejs_compat"] },
      limits:
        config.limits.cpuMs === undefined || capabilities.workersPlan !== "paid"
          ? undefined
          : { cpuMs: config.limits.cpuMs },
      env,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(ArtifactBucket);
    // Bound now so domain packages can wrap them in their own tags (STV-512).
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(CacheNamespace);
    const coordinatorNamespace = yield* Coordinator;

    const rateBindings = yield* Effect.forEach(RequestRateLimits, ({ binding, limit, period }) =>
      Effect.gen(function* () {
        const client = yield* binding;

        return { client, limit, period };
      }),
    );

    const checkpointBucket = yield* Cloudflare.R2.ReadWriteBucket(AuditCheckpointBucket);
    const auditStream = yield* AuditBasin;

    const auditWriter = Option.isSome(auditStream)
      ? Option.some(yield* Cloudflare.Basin.WriteStream(auditStream.value))
      : Option.none();

    const signingSecret = yield* Cloudflare.SecretsStore.ReadSecret(yield* SigningKey);
    const lifecycleSecret = yield* R2LifecycleToken;

    const lifecycleToken = Option.isSome(lifecycleSecret)
      ? Option.some(yield* Cloudflare.SecretsStore.ReadSecret(lifecycleSecret.value))
      : Option.none();

    const authSecret = yield* Cloudflare.SecretsStore.ReadSecret(yield* BetterAuthSecret);

    const githubOAuthSecret = yield* GitHubOAuthSecret;

    const githubSecret = Option.isSome(githubOAuthSecret)
      ? Option.some(yield* Cloudflare.SecretsStore.ReadSecret(githubOAuthSecret.value))
      : Option.none();

    const basinSecret = yield* BasinSqlToken;

    if (Option.isSome(basinSecret)) yield* Cloudflare.SecretsStore.ReadSecret(basinSecret.value);

    // Bound to the Worker as a secret at deploy time.
    const token = yield* Config.Redacted("TURBO_TOKEN");
    const email = yield* Cloudflare.Email.Send(yield* TransactionalEmail);
    const environment = yield* Cloudflare.Workers.WorkerEnvironment;
    // Alchemy resolves the custom domain, workers.dev URL, or local dev URL.
    // Deferred until request execution: the environment is absent at plan time.
    const publicUrl = yield* Cloudflare.Worker.URL;

    const edgeCacheEnabled = environment.EDGE_CACHE_ENABLED === "true";
    const execution = yield* Cloudflare.Workers.WorkerExecutionContext;

    // The deploy step writes these variables; a bad value is a deployment bug.
    const authEnvironment = yield* Effect.orDie(decodeAuthEnvironment(environment));

    const originLayer = Layer.unwrap(
      Effect.map(publicUrl, (url) => {
        const settings = resolveOriginSettings(new URL(url).origin, authEnvironment.OIDC_AUDIENCES);

        return Layer.mergeAll(
          Layer.succeed(CanonicalOrigin, settings.canonicalOrigin),
          Layer.succeed(OidcAudience, settings.oidcAudiences),
        );
      }),
    );

    const authConfig = Layer.effect(
      AuthConfig,
      Effect.gen(function* () {
        const origin = yield* CanonicalOrigin;
        const clientId = authEnvironment.GITHUB_CLIENT_ID;

        const github =
          Option.isSome(githubSecret) && clientId !== undefined
            ? { clientId, clientSecret: yield* githubSecret.value }
            : undefined;

        return {
          secret: yield* authSecret,
          baseURL: origin,
          trustedOrigins: [origin],
          github,
          groups: authEnvironment.GROUP_LIMITS,
          identityCeilings: authEnvironment.IDENTITY_CEILINGS,
        };
      }),
    );

    // D1 and KV bindings resolve per request (see @repo/db's README).
    const databaseLayer = DatabaseLive.pipe(Layer.provide(Layer.effect(D1Client, d1.raw)));

    const capabilities = authEnvironment.CAPABILITIES ?? (yield* DeploymentCapabilities);

    if (capabilities === undefined)
      return yield* Effect.die(new Error("Missing deployment capabilities"));

    const selectedLayers = capabilityLayers.pipe(
      Layer.provide(Layer.succeed(Capabilities, capabilities)),
      Layer.provide(databaseLayer),
    );

    const auditStreamEnabled = capabilities.auditHistory.enabled && Option.isSome(auditWriter);

    // Without Basin, audit rows stay in D1 (see docs/data-residency.md).
    const auditLayer = (
      auditStreamEnabled
        ? AuditLogLive.pipe(
            Layer.provide(
              makeAuditSink(
                (events) =>
                  // SAFETY: the binding client captures its env at init and never reads RuntimeContext.
                  auditWriter.value.send([...events]) as Effect.Effect<void, unknown>,
              ),
            ),
          )
        : AuditLogD1Only
    ).pipe(
      Layer.provide(Layer.succeed(AuditRetention, capabilities.auditRetentionDays * 86_400_000)),
    );

    const auditJobsLayer = AuditIntegrityLive.pipe(
      Layer.provideMerge(auditLayer),
      Layer.provide(
        Layer.effect(CheckpointStore, Effect.map(checkpointBucket.raw, makeCheckpointStore)),
      ),
      Layer.provide(databaseLayer),
    );

    // Cron failures are swallowed by the event source, so log them here.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      auditStreamEnabled
        ? drainOutboxJob.pipe(Effect.provide(auditJobsLayer), Effect.tapCause(Effect.logError))
        : Effect.void,
    );
    yield* Cloudflare.Workers.cron("17 3 * * *", () =>
      dailyAuditJob.pipe(Effect.provide(auditJobsLayer), Effect.tapCause(Effect.logError)),
    );
    yield* Cloudflare.Workers.cron("13 * * * *", () =>
      pruneOidcReplayIds.pipe(
        Effect.provide(ReplayGuardLive.pipe(Layer.provide(databaseLayer))),
        Effect.tapCause(Effect.logError),
      ),
    );

    const mailerLayer =
      capabilities.workersPlan === "local"
        ? MailerConsole
        : capabilities.emailSending.enabled && authEnvironment.EMAIL_FROM
          ? MailerLive.pipe(
              Layer.provide(
                Layer.effect(
                  EmailSend,
                  Effect.gen(function* () {
                    const binding = yield* email.raw;

                    return {
                      from: authEnvironment.EMAIL_FROM ?? "",
                      send: (message) => Effect.tryPromise(() => binding.send(message)),
                    };
                  }),
                ),
              ),
            )
          : MailerDisabled;

    const notificationsLayer = AlertsLive.pipe(
      Layer.provide(mailerLayer),
      Layer.provide(
        Layer.effect(
          NotificationSink,
          Effect.gen(function* () {
            const database = yield* DatabaseService;

            return {
              persist: (alert: import("@repo/mailer").Alert) =>
                database
                  .query("Notifications.persist", (db) =>
                    db
                      .insert(schema.notification)
                      .values({
                        id: alert.id,
                        userId: alert.userId,
                        kind: alert.kind,
                        detail: alert.detail,
                        createdAt: Date.now(),
                      })
                      .onConflictDoNothing(),
                  )
                  .pipe(
                    Effect.asVoid,
                    Effect.mapError((cause) => new MailerError({ cause })),
                  ),
            };
          }),
        ),
      ),
      Layer.provide(databaseLayer),
    );

    yield* Cloudflare.Workers.cron("43 4 * * *", () =>
      apiKeyDigestJob.pipe(
        Effect.provide(Layer.mergeAll(databaseLayer, authConfig, notificationsLayer)),
        Effect.provide(originLayer),
        Effect.tapCause(Effect.logError),
      ),
    );

    const coordinatorLayer = CoordinatorClientLive.pipe(
      Layer.provide(
        Layer.succeed(CoordinatorNamespace, makeCoordinatorNamespace(coordinatorNamespace)),
      ),
    );

    const limitsLayer = Layer.succeed(ProjectLimits, {
      retentionDays: authEnvironment.PROJECT_RETENTION_DAYS ?? 30,
      maxArtifactBytes: Math.min(
        authEnvironment.MAX_ARTIFACT_BYTES ?? 10_000_000_000,
        MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS,
      ),
    });

    const authorizationLayer = AuthorizationDatabaseLive.pipe(
      Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(auditLayer))),
      Layer.provide(Layer.succeed(AuthorizationCeilings, authEnvironment.IDENTITY_CEILINGS ?? {})),
    );

    const verifierLayer = CacheTokenVerifierLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          coordinatorLayer,
          CacheTokenConfigLive,
          KeyStoreLive.pipe(Layer.provide(Layer.effect(SigningKeySecret, signingSecret.raw))),
        ),
      ),
    );

    const rateLimitLayer = RateLimiterLive.pipe(
      Layer.provide(
        Layer.effect(
          RateLimitBinding,
          Effect.gen(function* () {
            const context = yield* Effect.context<RuntimeContext>();

            return {
              stage: JSON.stringify([
                yield* CanonicalOrigin,
                authEnvironment.RATE_LIMIT_STAGE ?? "default",
              ]),
              limit: (key, bucket) => {
                const binding = rateBindings.find(
                  (entry) => entry.limit === bucket.limit && entry.period === bucket.period,
                );

                return binding
                  ? binding.client.limit({ key }).pipe(Effect.provideContext(context))
                  : Effect.fail("Unsupported rate limit bucket");
              },
            } satisfies typeof RateLimitBinding.Service;
          }),
        ),
      ),
    );

    const authLayer = AuthLive.pipe(
      Layer.provide(rateLimitLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            ApiKeyEpochs,
            Effect.map(CoordinatorClient, (client) => ({
              read: (scope) =>
                makeCoordinatorNamespace(coordinatorNamespace)
                  .getByName(`epoch:${scope}`)
                  .revocationEpoch(),
              bump: client.revokeAll,
            })),
          ).pipe(Layer.provide(coordinatorLayer)),
          Layer.succeed(ApiKeyBackground, { run: (task) => execution.raw.waitUntil(task) }),
          auditLayer,
          SecondaryStorageLive.pipe(Layer.provide(Layer.effect(AuthKvNamespace, kv.raw))),
          authConfig,
          selectedLayers,
          mailerLayer,
          notificationsLayer,
        ),
      ),
      Layer.provide(databaseLayer),
    );

    const cacheAuthorizationLayer = Layer.mergeAll(
      coordinatorLayer,
      authorizationLayer,
      AuthorizationAuditLive.pipe(Layer.provide(auditLayer)),
      CredentialResolverLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            verifierLayer,
            ApiKeyVerifierLive.pipe(Layer.provide(authLayer)),
            Layer.succeed(LegacyCredentialConfig, {
              enabled: authEnvironment.LEGACY_TOKEN_ENABLED === "true",
              token,
            }),
          ),
        ),
      ),
      InstanceSettingsRepoLive,
      limitsLayer,
      Layer.succeed(AuthorizationCeilings, authEnvironment.IDENTITY_CEILINGS ?? {}),
    ).pipe(Layer.provideMerge(databaseLayer));

    const retentionRulesLayer =
      Option.isSome(lifecycleToken) &&
      authEnvironment.R2_LIFECYCLE_ACCOUNT_ID &&
      authEnvironment.R2_LIFECYCLE_BUCKET
        ? Layer.effect(
            ProjectRetentionRules,
            Effect.map(lifecycleToken.value.raw, (secret) =>
              makeRetentionRules({
                accountId: authEnvironment.R2_LIFECYCLE_ACCOUNT_ID!,
                bucketName: authEnvironment.R2_LIFECYCLE_BUCKET!,
                jurisdiction: authEnvironment.R2_LIFECYCLE_JURISDICTION,
                token: () => secret.get(),
                fetch: globalThis.fetch,
              }),
            ),
          )
        : Layer.empty;

    const maintenanceLayer = ProjectMaintenanceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          auditLayer,
          InstanceSettingsRepoLive,
          limitsLayer,
          retentionRulesLayer,
          Layer.succeed(AuthorizationCeilings, authEnvironment.IDENTITY_CEILINGS ?? {}),
          Layer.effect(
            ProjectStorage,
            Effect.gen(function* () {
              const raw = yield* bucket.raw;
              const coordinator = yield* CoordinatorClient;

              return {
                list: (prefix: string, cursor?: string) =>
                  Effect.tryPromise(async () => {
                    const page = await raw.list({ prefix, cursor, limit: 1000 });

                    return {
                      objects: page.objects.map(({ key, uploaded }) => ({ key, uploaded })),
                      cursor: page.truncated ? page.cursor : undefined,
                    };
                  }),
                delete: (keys: readonly string[]) => Effect.tryPromise(() => raw.delete([...keys])),
                revoke: (id: string) =>
                  coordinator
                    .revokeAll(`project:${id}`)
                    .pipe(Effect.andThen(coordinator.invalidateCache(id)), Effect.asVoid),
              };
            }),
          ).pipe(Layer.provide(coordinatorLayer)),
        ),
      ),
      Layer.provide(databaseLayer),
    );

    yield* Cloudflare.Workers.cron("*/2 * * * *", () =>
      Effect.gen(function* () {
        const maintenance = yield* ProjectMaintenance;
        yield* maintenance.tick;
      }).pipe(Effect.provide(maintenanceLayer), Effect.tapCause(Effect.logError)),
    );

    const incidentLayer = IncidentPurgeLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          PurgeJobsLive.pipe(Layer.provide(auditLayer), Layer.provide(databaseLayer)),
          Layer.effect(
            PurgeInventory,
            Effect.gen(function* () {
              const raw = yield* bucket.raw;
              const convert = (o: {
                key: string;
                etag: string;
                size: number;
                uploaded: Date;
                customMetadata?: Record<string, string> | undefined;
              }) => ({
                key: o.key,
                etag: o.etag,
                size: o.size,
                uploaded: o.uploaded.getTime(),
                metadata: o.customMetadata ?? {},
              });
              const fail = () => new PurgeError({ message: "Purge storage or audit unavailable" });
              return {
                list: (prefix: string, cursor?: string) =>
                  Effect.tryPromise(async () => {
                    const page = await raw.list({
                      prefix,
                      cursor,
                      limit: 100,
                      include: ["customMetadata"],
                    });
                    return {
                      objects: page.objects.map(convert),
                      cursor: page.truncated ? page.cursor : undefined,
                    };
                  }).pipe(Effect.mapError(fail)),
                head: (key: string) =>
                  Effect.tryPromise(() => raw.head(key)).pipe(
                    Effect.map((o) => (o ? convert(o) : null)),
                    Effect.mapError(fail),
                  ),
                remove: (keys: readonly string[]) =>
                  keys.length
                    ? Effect.tryPromise(() => raw.delete([...keys])).pipe(Effect.mapError(fail))
                    : Effect.void,
              };
            }),
          ),
          Layer.effect(
            ArtifactPurger,
            Effect.map(CoordinatorClient, (coordinator) => ({
              invalidate: coordinator.invalidateCache,
              remove: () => Effect.die("Use the batch purge inventory"),
            })),
          ).pipe(Layer.provide(coordinatorLayer)),
        ),
      ),
    );
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.flatMap(IncidentPurge, (p) => p.tick).pipe(
        Effect.provide(incidentLayer),
        Effect.tapCause(Effect.logError),
      ),
    );
    const purge = purgeRoute.pipe(
      Effect.provide(
        Layer.mergeAll(
          incidentLayer,
          authLayer,
          authorizationLayer,
          ProjectRepoLive,
          InstanceSettingsRepoLive,
        ).pipe(Layer.provideMerge(databaseLayer)),
      ),
      Effect.catch(() =>
        HttpServerResponse.json(
          { message: "Purge unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        ),
      ),
    );

    const multipartLayer = MultipartUploadsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(MultipartSecret, authSecret),
          Layer.effect(MultipartBucket, Effect.map(bucket.raw, makeMultipartBucket)),
        ),
      ),
    );

    const artifacts = artifactApi({
      uploadChunked: (key, body, options) =>
        Effect.flatMap(bucket.raw, (raw) => uploadChunked(raw, key, body, options)),
      multipart: (scope, recheck) =>
        multipartRoute(
          scope,
          recheck,
          (scope, operation) =>
            Effect.flatMap(ArtifactOpEmitter, (emitter) =>
              emitter.emit(
                { orgId: scope.credential!.orgId, projectId: scope.credential!.projectId },
                operation,
              ),
            ).pipe(
              Effect.provide(ArtifactOpEmitterD1Uploads.pipe(Layer.provide(databaseLayer))),
              Effect.catch(() => Effect.void),
            ),
          (hash) =>
            EdgeCache.createArtifactCache(edgeCacheEnabled).remove(
              scope.prefix,
              hash,
              scope.cacheGeneration,
            ),
        ).pipe(
          Effect.provide(multipartLayer),
          Effect.mapError((error) =>
            error instanceof ApiError
              ? error
              : new ApiError({
                  status: 503,
                  code: "multipart_unavailable",
                  message: "Multipart upload unavailable",
                }),
          ),
        ),
      guard: (scope) => cacheCredentialGuard(scope).pipe(Effect.provide(rateLimitLayer)),
      guardAuthFailure: cacheAuthenticationFailureGuard.pipe(Effect.provide(rateLimitLayer)),
      authorize: (credential, url, action) =>
        authorizeProjectCache(credential, url, action).pipe(
          Effect.provide(cacheAuthorizationLayer),
          Effect.tap((scope) =>
            action === "cache:write" &&
            !url.pathname.endsWith("/abort") &&
            scope.credential?.credentialType !== "legacy"
              ? Effect.gen(function* () {
                  const db = yield* DatabaseService;
                  const [active] = yield* db.query("Purge.writeFence", (q) =>
                    q
                      .select({ id: schema.artifactPurgeJob.id })
                      .from(schema.artifactPurgeJob)
                      .where(
                        and(
                          eq(schema.artifactPurgeJob.projectId, scope.credential!.projectId),
                          eq(schema.artifactPurgeJob.state, "queued"),
                        ),
                      )
                      .limit(1),
                  );
                  if (active)
                    return yield* new ApiError({
                      status: 409,
                      code: "purge_in_progress",
                      message: "Project writes are paused while a purge is running",
                    });
                }).pipe(Effect.provide(databaseLayer))
              : Effect.void,
          ),
          Effect.mapError((error) =>
            error instanceof ApiError
              ? error
              : new ApiError({
                  status: 500,
                  code: "unavailable",
                  message: "Cache authorization unavailable",
                }),
          ),
        ),
      emitArtifactOp: (scope, operation) =>
        Effect.flatMap(ArtifactOpEmitter, (emitter) =>
          emitter.emit(
            {
              orgId:
                scope.credential?.credentialType === "legacy"
                  ? scope.prefix
                  : (scope.credential?.orgId ?? scope.prefix),
              projectId:
                scope.credential?.credentialType === "legacy"
                  ? scope.prefix
                  : (scope.credential?.projectId ?? scope.prefix),
            },
            operation,
          ),
        ).pipe(
          Effect.provide(ArtifactOpEmitterD1Uploads.pipe(Layer.provide(databaseLayer))),
          Effect.catch(() => Effect.void),
        ),
      auditDenial: (error) =>
        Effect.gen(function* () {
          const audit = yield* AuditLog;
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* audit.commit(
            {
              scope: "instance",
              actor: { type: "system", id: "cache-api", display: "Cache API" },
              action: "cache.authentication",
              target: { type: "cache", id: "cache-api" },
              outcome: "deny",
              reason: error.code,
              ip: request.headers["cf-connecting-ip"] ?? "",
              userAgent: request.headers["user-agent"] ?? "",
              requestId: crypto.randomUUID(),
              metadata: { method: request.method, status: error.status },
            },
            () => [],
          );
        }).pipe(
          Effect.provide(auditLayer.pipe(Layer.provide(databaseLayer))),
          Effect.mapError(
            () =>
              new ApiError({
                status: 500,
                code: "unavailable",
                message: "Cache audit unavailable",
              }),
          ),
        ),
      bucket,
      token,
      edgeCacheEnabled,
      cache: EdgeCache.createArtifactCache(edgeCacheEnabled),
      waitUntil: execution.waitUntil,
      maxUploadBytes:
        authEnvironment.MAX_DIRECT_UPLOAD_BYTES ??
        (capabilities.directUploads.enabled ? 200_000_000 : 100_000_000),
      emitEvents: Effect.fn("Server.emitCacheEvents")(
        function* (team, events) {
          const emitter = yield* AnalyticsEmitter;
          const [orgId = team, projectId = orgId] = team.split("/");
          yield* emitter.emit({ orgId, projectId }, events);
        },
        Effect.provide(selectedLayers),
        Effect.tapCause(Effect.logError),
        Effect.catch(() => Effect.void),
      ),
    });

    const auth = authRoute(authLayer);

    const projectsLayer = ProjectsLive.pipe(
      Layer.provide(PolicyGuardrailsLive),
      Layer.provide(
        Layer.mergeAll(
          ProjectRepoLive,
          InstanceSettingsRepoLive,
          authorizationLayer,
          auditLayer,
          authConfig,
          limitsLayer,
        ),
      ),
      Layer.provide(databaseLayer),
    );

    const projects = projectsRoute(Layer.mergeAll(authLayer, projectsLayer));

    const report = capabilitiesRoute(capabilities, token).pipe(
      Effect.provide(authLayer),
      Effect.catch(() =>
        HttpServerResponse.json(
          { code: "internal_error" },
          { status: 500, headers: { "cache-control": "no-store" } },
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { pathname } = new URL(request.url, "http://localhost");

        if (pathname === "/oidc/exchange" || pathname === "/api/oidc/exchange") {
          const denied = yield* oidcExchangeGuard.pipe(
            Effect.provide(rateLimitLayer),
            Effect.result,
          );

          if (denied._tag === "Failure")
            return yield* HttpServerResponse.json(
              { code: denied.failure.code, message: denied.failure.message },
              {
                status: denied.failure.status,
                headers: denied.failure.retryAfter
                  ? { "Retry-After": String(denied.failure.retryAfter) }
                  : {},
              },
            );
        }

        if (pathname === "/api/instance/capabilities") return yield* report;

        if (purgePath.test(pathname)) return yield* purge;

        if (isProjectsPath(pathname)) return yield* projects;

        return yield* isAuthPath(pathname) ? auth : artifacts;
      }).pipe(withSecurityHeaders, Effect.provide(originLayer)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Email.SendBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.KV.ReadWriteNamespaceBinding,
        Cloudflare.SecretsStore.ReadSecretBinding,
        Cloudflare.Workers.RateLimitBinding,
        CoordinatorLive,
        Cloudflare.Basin.WriteStreamBinding,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
) {}
