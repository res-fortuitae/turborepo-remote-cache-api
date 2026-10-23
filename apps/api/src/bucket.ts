import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { loadDeployConfig } from "../scripts/config.ts";

/** R2 bucket holding Turborepo cache artifacts, keyed by `<team>/<hash>`. */
export const ArtifactBucket = Cloudflare.R2.Bucket(
  "Artifacts",
  Effect.suspend(() => {
    // Alchemy evaluates resource declarations in the deployed Worker too.
    if (globalThis.__ALCHEMY_RUNTIME__) return Effect.succeed({});

    return Effect.map(
      Effect.promise(() => loadDeployConfig()),
      (config) => ({
        jurisdiction: config.jurisdiction,
        lifecycleRules: [
          {
            id: "expire-old-artifacts",
            deleteObjectsTransition: {
              condition: {
                type: "Age" as const,
                maxAge: 60 * 60 * 24 * config.limits.artifactRetentionDays,
              },
            },
          },
          {
            id: "abort-stale-multipart-uploads",
            abortMultipartUploadsTransition: {
              condition: { type: "Age" as const, maxAge: 60 * 60 * 24 },
            },
          },
        ],
      }),
    );
  }),
);
