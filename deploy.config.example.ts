import { defineDeployConfig } from "@repo/deploy-config";

// Copy with `bun run setup`. Only deploy.config.ts belongs to your organization.
export default defineDeployConfig({
  // domain: "cache.example.com",
  // stagingDomain: "cache-staging.example.com",
  // Defaults to this stage's origin. Pin old/new values when migrating a domain.
  // oidcAudiences: ["https://cache.example.com"],
  jurisdiction: "default",
  // Public identifiers only. Credentials belong in the root .env or a secret store.
  // githubApp: { appId: 123, clientId: "Iv1.example", slug: "my-cache" },
  // Optional deployment ceilings; runtime org policy can only tighten these.
  // identityCeilings: { maxCacheRequestsPerMinute: 300, maxQueryHashes: 100 },
  limits: { artifactRetentionDays: 30 },
  // Optional workersPlan: "free" | "paid" asserts billing when the deploy token cannot read it.
  // Optional feature flags emailSending, analytics, auditHistory, directUploads default to requested.
  // False always selects the fallback; plan eligibility alone never enables a pending integration.
  // Add legacyToken: true only while migrating shared-token cache clients.
  features: { edgeCache: true },
  stages: { production: "production", staging: "staging" },
});
