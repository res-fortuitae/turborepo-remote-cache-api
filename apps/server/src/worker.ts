import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
  AuditIntegrityLive,
  AuditRetention,
  AuditLogLive,
  AuditLogD1Only,
  CheckpointStore,
  dailyAuditJob,
  drainOutboxJob,
  makeAuditSink,
  makeCheckpointStore,
} from "@repo/audit";
import { AuthKvNamespace, AuthLive, SecondaryStorageLive } from "@repo/auth";
import { Coordinator, CoordinatorLive } from "@repo/coordinator";
import { D1Client, DatabaseLive, ReplayGuardLive } from "@repo/db";
import { pruneOidcReplayIds } from "@repo/oidc";
import {
  AuthConfig,
  CanonicalOrigin,
  OidcAudience,
  OidcAudiences,
  resolveOriginSettings,
} from "@repo/deploy-config";
import { AnalyticsEmitter } from "@repo/analytics";
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
  RateLimiter,
  SigningKey,
} from "@repo/infra";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { artifactApi } from "./api.ts";
import { authRoute, isAuthPath } from "./auth.ts";
import { workerDomain } from "./deploy-config.ts";
import { loadDeployConfig } from "../scripts/config.ts";
import { resolveDeployment, validateGitHubOAuth } from "./deployment.ts";
import * as EdgeCache from "./edge-cache.ts";
import { withSecurityHeaders } from "./security-headers.ts";

const AuthEnvironment = Schema.Struct({
  OIDC_AUDIENCES: Schema.optional(Schema.fromJsonString(OidcAudiences)),
  CAPABILITIES: Schema.optional(Schema.fromJsonString(CapabilityReport)),
  GITHUB_CLIENT_ID: Schema.optional(Schema.NonEmptyString),
});

interface DeploymentEnvironment {
  EDGE_CACHE_ENABLED: string;
  CAPABILITIES: string;
  OIDC_AUDIENCES?: string;
  GITHUB_CLIENT_ID?: string;
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
      EDGE_CACHE_ENABLED: String(resolveDeployment(config).edgeCacheEnabled),
      CAPABILITIES: JSON.stringify(capabilities),
    };

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
    yield* Coordinator;
    yield* RateLimiter;
    const checkpointBucket = yield* Cloudflare.R2.ReadWriteBucket(AuditCheckpointBucket);
    const auditStream = yield* AuditBasin;

    const auditWriter = Option.isSome(auditStream)
      ? Option.some(yield* Cloudflare.Basin.WriteStream(auditStream.value))
      : Option.none();

    yield* Cloudflare.SecretsStore.ReadSecret(yield* SigningKey);
    const authSecret = yield* Cloudflare.SecretsStore.ReadSecret(yield* BetterAuthSecret);

    const githubOAuthSecret = yield* GitHubOAuthSecret;

    const githubSecret = Option.isSome(githubOAuthSecret)
      ? Option.some(yield* Cloudflare.SecretsStore.ReadSecret(githubOAuthSecret.value))
      : Option.none();

    const basinSecret = yield* BasinSqlToken;

    if (Option.isSome(basinSecret)) yield* Cloudflare.SecretsStore.ReadSecret(basinSecret.value);

    // Bound to the Worker as a secret at deploy time.
    const token = yield* Config.Redacted("TURBO_TOKEN");
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

    const authLayer = AuthLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          auditLayer,
          SecondaryStorageLive.pipe(Layer.provide(Layer.effect(AuthKvNamespace, kv.raw))),
          authConfig,
          selectedLayers,
        ),
      ),
      Layer.provide(databaseLayer),
    );

    const artifacts = artifactApi({
      bucket,
      token,
      edgeCacheEnabled,
      cache: EdgeCache.createArtifactCache(edgeCacheEnabled),
      waitUntil: execution.waitUntil,
      maxUploadBytes: capabilities.directUploads.enabled ? 200_000_000 : 100_000_000,
      emitEvents: Effect.fn("Server.emitCacheEvents")(
        function* (team, events) {
          const emitter = yield* AnalyticsEmitter;
          // Until project routing lands, Turbo's team namespace is the legacy project scope.
          yield* emitter.emit({ orgId: team, projectId: team }, events);
        },
        Effect.provide(selectedLayers),
        Effect.tapCause(Effect.logError),
        Effect.catch(() => Effect.void),
      ),
    });

    const auth = authRoute(authLayer);

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

        if (pathname === "/api/instance/capabilities") return yield* report;

        return yield* isAuthPath(pathname) ? auth : artifacts;
      }).pipe(withSecurityHeaders, Effect.provide(originLayer)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
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
