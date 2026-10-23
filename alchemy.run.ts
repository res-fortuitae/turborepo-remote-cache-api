import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { ArtifactBucket } from "./apps/server/src/bucket.ts";
import { resolveDeployment } from "./apps/server/src/deployment.ts";
import { loadDeployConfig } from "./apps/server/scripts/config.ts";
import Worker from "./apps/server/src/worker.ts";

export default Alchemy.Stack(
  "TurborepoRemoteCache",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const config = yield* Effect.promise(() => loadDeployConfig());
    const { residency } = resolveDeployment(config);
    const bucket = yield* ArtifactBucket;
    const worker = yield* Worker;

    return {
      jurisdiction: residency.jurisdiction ?? "automatic",
      basinDisabledReason: residency.basinDisabledReason,
      bucketName: bucket.bucketName,
      url: worker.url,
    };
  }),
);
