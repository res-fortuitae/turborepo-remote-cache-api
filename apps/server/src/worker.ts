import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Coordinator, CoordinatorLive } from "@repo/coordinator";
import {
  ArtifactBucket,
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
import { artifactApi } from "./api.ts";
import { workerDomain } from "./deploy-config.ts";
import { loadDeployConfig } from "../scripts/config.ts";
import { resolveDeployment } from "./deployment.ts";
import * as EdgeCache from "./edge-cache.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    // Deployment config is local to the operator and absent from the Worker.
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };

    const config = yield* Effect.promise(() => loadDeployConfig());
    const stage = yield* Stage;

    return {
      main: import.meta.url,
      assets: DashboardAssets,
      domain: workerDomain(config, stage),
      limits: config.limits.cpuMs === undefined ? undefined : { cpuMs: config.limits.cpuMs },
      env: { EDGE_CACHE_ENABLED: String(resolveDeployment(config).edgeCacheEnabled) },
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(ArtifactBucket);
    // Bound now so domain packages can wrap them in their own tags (STV-512).
    yield* Cloudflare.D1.QueryDatabase(Database);
    yield* Cloudflare.KV.ReadWriteNamespace(CacheNamespace);
    yield* Coordinator;
    yield* RateLimiter;

    for (const secret of [yield* SigningKey, yield* BetterAuthSecret]) {
      yield* Cloudflare.SecretsStore.ReadSecret(secret);
    }

    for (const secret of [yield* GitHubOAuthSecret, yield* BasinSqlToken]) {
      if (Option.isSome(secret)) yield* Cloudflare.SecretsStore.ReadSecret(secret.value);
    }

    // Bound to the Worker as a secret at deploy time.
    const token = yield* Config.Redacted("TURBO_TOKEN");
    const environment = yield* Cloudflare.Workers.WorkerEnvironment;

    const edgeCacheEnabled = environment.EDGE_CACHE_ENABLED === "true";
    const execution = yield* Cloudflare.Workers.WorkerExecutionContext;

    return {
      fetch: artifactApi({
        bucket,
        token,
        edgeCacheEnabled,
        cache: EdgeCache.createArtifactCache(edgeCacheEnabled),
        waitUntil: execution.waitUntil,
      }),
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
      ),
    ),
  ),
) {}
