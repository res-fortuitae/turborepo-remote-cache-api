export type Jurisdiction = "eu" | "fedramp";

export interface DeployConfig {
  readonly jurisdiction?: Jurisdiction;
}

/** Deployment policy, shared by resource declarations and the Worker bundle. */
export const resolveResidency = (config: DeployConfig) => {
  const { jurisdiction } = config;

  if (jurisdiction !== undefined && jurisdiction !== "eu" && jurisdiction !== "fedramp") {
    throw new Error('deploy.config.ts: jurisdiction must be omitted, "eu", or "fedramp"');
  }

  const restricted = jurisdiction !== undefined;

  return {
    jurisdiction,
    // Apply to every application bucket and to D1 at creation; do not add location hints.
    storage: { jurisdiction },
    allowArtifactEdgeCache: !restricted,
    allowKvSessionCache: !restricted,
    allowBasin: !restricted,
    basinDisabledReason: restricted
      ? "Basin Catalog does not support R2 buckets in a non-default jurisdiction. Use D1 hourly analytics and D1 audit history with weekly exports to a jurisdiction-restricted backup bucket."
      : undefined,
  } as const;
};
