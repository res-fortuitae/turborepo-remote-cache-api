import * as Schema from "effect/Schema";

const CacheRate = Schema.Literals([10, 30, 60, 100, 300, 600]);
const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const IdentityCeilings = Schema.Struct({
  maxCacheRequestsPerMinute: Schema.optional(CacheRate),
  maxQueryHashes: Schema.optional(Positive),
  maxTokenTtlSeconds: Schema.optional(Positive),
  maxApiKeyLifetimeDays: Schema.optional(Positive),
  maxRetentionDays: Schema.optional(Positive),
  maxQuotaBytes: Schema.optional(Positive),
  allowedOidcIssuers: Schema.optional(Schema.Array(Schema.String)),
});

export type IdentityCeilings = typeof IdentityCeilings.Type;

export const InstancePolicy = Schema.Struct({
  cacheRequestsPerMinute: Schema.optional(CacheRate),
  maxQueryHashes: Schema.optional(Positive),
  orgCreation: Schema.Literals(["anyone", "admins"]),
  allowedEmailDomains: Schema.Array(Schema.NonEmptyString),
  allowedGithubOrgs: Schema.Array(Schema.NonEmptyString),
  allowedOidcIssuers: Schema.Array(Schema.NonEmptyString),
  maxTokenTtlSeconds: Positive,
  apiKeys: Schema.Literals(["allowed", "warn", "disallowed"]),
  maxApiKeyLifetimeDays: Positive,
  retentionDays: Positive,
  quotaBytes: Positive,
  requireArtifactSigning: Schema.Boolean,
  requireBoundTokens: Schema.Boolean,
  requirePasskeyForAdmins: Schema.Boolean,
});

export type InstancePolicy = typeof InstancePolicy.Type;

export const defaultInstancePolicy: InstancePolicy = {
  cacheRequestsPerMinute: 600,
  maxQueryHashes: 100,
  orgCreation: "admins",
  allowedEmailDomains: [],
  allowedGithubOrgs: [],
  allowedOidcIssuers: ["https://token.actions.githubusercontent.com", "https://oidc.vercel.com"],
  maxTokenTtlSeconds: 900,
  apiKeys: "warn",
  maxApiKeyLifetimeDays: 30,
  retentionDays: 30,
  quotaBytes: 10_000_000_000,
  requireArtifactSigning: false,
  requireBoundTokens: false,
  requirePasskeyForAdmins: false,
};

/** Runtime settings and org policy can only tighten deployment/instance ceilings. */
export const clampPolicy = (
  policy: InstancePolicy,
  ceilings: IdentityCeilings,
): InstancePolicy => ({
  ...policy,
  cacheRequestsPerMinute:
    (policy.cacheRequestsPerMinute ?? 600) < (ceilings.maxCacheRequestsPerMinute ?? 600)
      ? (policy.cacheRequestsPerMinute ?? 600)
      : (ceilings.maxCacheRequestsPerMinute ?? 600),
  maxQueryHashes: Math.min(policy.maxQueryHashes ?? 100, ceilings.maxQueryHashes ?? 1000, 1000),
  maxTokenTtlSeconds: Math.min(policy.maxTokenTtlSeconds, ceilings.maxTokenTtlSeconds ?? 900),
  maxApiKeyLifetimeDays: Math.min(
    policy.maxApiKeyLifetimeDays,
    ceilings.maxApiKeyLifetimeDays ?? 90,
    90,
  ),
  retentionDays: Math.min(policy.retentionDays, ceilings.maxRetentionDays ?? 365),
  quotaBytes: Math.min(policy.quotaBytes, ceilings.maxQuotaBytes ?? Number.MAX_SAFE_INTEGER),
  allowedOidcIssuers: policy.allowedOidcIssuers.filter(
    (issuer) =>
      ceilings.allowedOidcIssuers === undefined || ceilings.allowedOidcIssuers.includes(issuer),
  ),
});

/** Effective organization policy can never weaken its instance's policy. */
export const tightenPolicy = (
  parent: InstancePolicy,
  requested: InstancePolicy,
): InstancePolicy => {
  const intersect = (ceiling: readonly string[], child: readonly string[]) => {
    if (ceiling.length === 0) return child;

    if (child.length === 0) return ceiling;
    const result = child.filter((value) => ceiling.includes(value));

    if (!result.length)
      throw new Error("Organization allowlist must overlap its instance allowlist");

    return result;
  };

  const apiKeyRank = { allowed: 0, warn: 1, disallowed: 2 };

  return {
    ...clampPolicy(requested, {
      maxCacheRequestsPerMinute: parent.cacheRequestsPerMinute ?? 600,
      maxQueryHashes: parent.maxQueryHashes ?? 100,
      maxTokenTtlSeconds: parent.maxTokenTtlSeconds,
      maxApiKeyLifetimeDays: parent.maxApiKeyLifetimeDays,
      maxRetentionDays: parent.retentionDays,
      maxQuotaBytes: parent.quotaBytes,
      allowedOidcIssuers: parent.allowedOidcIssuers,
    }),
    orgCreation: parent.orgCreation === "admins" ? "admins" : requested.orgCreation,
    allowedEmailDomains: intersect(parent.allowedEmailDomains, requested.allowedEmailDomains),
    allowedGithubOrgs: intersect(parent.allowedGithubOrgs, requested.allowedGithubOrgs),
    apiKeys:
      apiKeyRank[parent.apiKeys] > apiKeyRank[requested.apiKeys]
        ? parent.apiKeys
        : requested.apiKeys,
    requireArtifactSigning: parent.requireArtifactSigning || requested.requireArtifactSigning,
    requireBoundTokens: parent.requireBoundTokens || requested.requireBoundTokens,
    requirePasskeyForAdmins: parent.requirePasskeyForAdmins || requested.requirePasskeyForAdmins,
  };
};
