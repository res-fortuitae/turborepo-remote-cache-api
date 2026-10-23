import * as Cloudflare from "alchemy/Cloudflare";
import { residency } from "./deployment.ts";

/** Artifacts are deleted this long after upload (matches the 720h default of turborepo-remote-cache-cloudflare). */
export const ARTIFACT_RETENTION_DAYS = 30;

/** R2 bucket holding Turborepo cache artifacts, keyed by `<team>/<hash>`. */
export const ArtifactBucket = Cloudflare.R2.Bucket("Artifacts", {
  ...residency.storage,
  lifecycleRules: [
    {
      id: "expire-old-artifacts",
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 60 * 60 * 24 * ARTIFACT_RETENTION_DAYS },
      },
    },
    {
      id: "abort-stale-multipart-uploads",
      abortMultipartUploadsTransition: {
        condition: { type: "Age", maxAge: 60 * 60 * 24 },
      },
    },
  ],
});
