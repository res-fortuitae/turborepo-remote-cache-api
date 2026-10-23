import type { DeployConfig } from "./deploy-config.ts";
import { resolveResidency } from "./residency.ts";

/** Resolve organization settings through the mandatory residency restrictions. */
export const resolveDeployment = (config: DeployConfig) => {
  const residency = resolveResidency({
    jurisdiction: config.jurisdiction === "default" ? undefined : config.jurisdiction,
  });

  return {
    residency,
    edgeCacheEnabled: config.features.edgeCache && residency.allowArtifactEdgeCache,
  };
};
