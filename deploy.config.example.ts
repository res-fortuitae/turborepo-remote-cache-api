import { defineDeployConfig } from "./apps/api/src/deploy-config.ts";

// Copy with `bun run setup`. Only deploy.config.ts belongs to your organization.
export default defineDeployConfig({
  // domain: "cache.example.com",
  // stagingDomain: "cache-staging.example.com",
  jurisdiction: "default",
  // Public identifiers only. Credentials belong in apps/api/.env or a secret store.
  // githubApp: { appId: 123, clientId: "Iv1.example", slug: "my-cache" },
  limits: { artifactRetentionDays: 30 },
  features: { edgeCache: true },
  stages: { production: "production", staging: "staging" },
});
