import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Stage } from "alchemy/Stage";
import {
  ArtifactBucket,
  AnalyticsBasin,
  BackupBucket,
  CacheNamespace,
  Database,
  detectCapabilities,
  InfraConfig,
  retainStatefulResources,
} from "@repo/infra";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import { workerDomain } from "@repo/deploy-config";
import { resolveDeployment } from "./apps/server/src/deployment.ts";
import { loadDeployConfig } from "./apps/server/scripts/config.ts";
import { DeploymentCapabilities } from "./apps/server/src/capabilities.ts";
import Worker from "./apps/server/src/worker.ts";

export default Alchemy.Stack(
  "TurborepoRemoteCache",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Alchemy.AlchemyContext.pipe(
        Effect.map(({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
      ),
    ),
  },
  Effect.gen(function* () {
    const config = yield* Effect.promise(() => loadDeployConfig());
    const { dev } = yield* Alchemy.AlchemyContext;
    const { residency } = resolveDeployment(config);

    const stage = yield* Stage;

    const catalogToken = yield* Config.option(Config.Redacted("BASIN_CATALOG_TOKEN")).pipe(
      Effect.orDie,
    );

    const capabilities = yield* detectCapabilities({
      dev,
      domain: workerDomain(config, stage),
      jurisdiction: residency.jurisdiction,
      workersPlan: config.workersPlan,
      features: config.features,
      emailConfigured: config.email !== undefined,
      catalogToken: Option.isSome(catalogToken),
    });

    return yield* Effect.gen(function* () {
      const bucket = yield* ArtifactBucket;
      const database = yield* Database;
      const cache = yield* CacheNamespace;
      yield* BackupBucket;
      yield* AnalyticsBasin;
      const worker = yield* Worker;

      return {
        capabilities,
        jurisdiction: residency.jurisdiction ?? "automatic",
        basinDisabledReason: capabilities.auditHistory.enabled
          ? undefined
          : capabilities.auditHistory.reason,
        bucketName: bucket.bucketName,
        databaseId: database.databaseId,
        cacheNamespaceId: cache.namespaceId,
        url: worker.url,
      };
    }).pipe(
      Effect.provideService(DeploymentCapabilities, capabilities),
      // The Worker owns Coordinator's namespace: retain its host along with the data.
      // Disposable resources override this scope in @repo/infra.
      retainStatefulResources(stage, config.stages),
      Effect.provideService(InfraConfig, {
        stage,
        jurisdiction: residency.jurisdiction,
        artifactRetentionDays: config.limits.artifactRetentionDays,
        auditHistoryEnabled: capabilities.auditHistory.enabled,
        analyticsInfrastructureEnabled:
          capabilities.workersPlan === "paid" && config.features.analytics !== false,
      }),
    );
  }),
);
