import type { DeployConfig } from "./deploy-config.ts";
import { resolveResidency } from "./residency.ts";

/** A half-configured provider should fail planning, rather than silently disappear. */
export const validateGitHubOAuth = (
  config: Pick<DeployConfig, "githubApp">,
  secretConfigured: boolean,
) => {
  if ((config.githubApp !== undefined) !== secretConfigured) {
    throw new Error(
      "GitHub OAuth requires both deploy.config.ts githubApp and GITHUB_OAUTH_CLIENT_SECRET",
    );
  }
};

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
