import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Stage } from "alchemy/Stage";
import { ArtifactBucket, CacheNamespace, Database, InfraConfig } from "@repo/infra";
import { resolveDeployment } from "./apps/server/src/deployment.ts";
import { loadDeployConfig } from "./apps/server/scripts/config.ts";
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

    return yield* Effect.gen(function* () {
      const bucket = yield* ArtifactBucket;
      const database = yield* Database;
      const cache = yield* CacheNamespace;
      const worker = yield* Worker;

      return {
        jurisdiction: residency.jurisdiction ?? "automatic",
        basinDisabledReason: dev
          ? "Basin has no local resource provider; audit events remain in local D1."
          : residency.basinDisabledReason,
        bucketName: bucket.bucketName,
        databaseId: database.databaseId,
        cacheNamespaceId: cache.namespaceId,
        url: worker.url,
      };
    }).pipe(
      Effect.provideService(InfraConfig, {
        stage,
        jurisdiction: residency.jurisdiction,
        artifactRetentionDays: config.limits.artifactRetentionDays,
      }),
    );
  }),
);
