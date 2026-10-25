import * as Schema from "effect/Schema";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const IdentityCeilings = Schema.Struct({
  maxTokenTtlSeconds: Schema.optional(Positive),
  maxApiKeyLifetimeDays: Schema.optional(Positive),
  maxRetentionDays: Schema.optional(Positive),
  maxQuotaBytes: Schema.optional(Positive),
  allowedOidcIssuers: Schema.optional(Schema.Array(Schema.String)),
});

export type IdentityCeilings = typeof IdentityCeilings.Type;

export const InstancePolicy = Schema.Struct({
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
