import { IdentityCeilings } from "./identity-policy.ts";
import * as Schema from "effect/Schema";
import { CustomOidcIssuers } from "./oidc-issuers.ts";
import { OidcAudiences } from "./origin.ts";

const Hostname = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
);

const StageName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const DeployConfigSchema = Schema.Struct({
  domain: Schema.optional(Hostname),
  stagingDomain: Schema.optional(Hostname),
  /** Stable production Worker name, allowing OAuth setup before the first deploy. */
  productionWorkerName: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
  ),
  /** Omit to accept this stage's canonical origin. Pin during domain migrations. */
  oidcAudiences: Schema.optional(OidcAudiences),
  oidcCustomIssuers: Schema.optional(CustomOidcIssuers),
  email: Schema.optional(
    Schema.Struct({ from: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) }),
  ),
  groups: Schema.optional(
    Schema.Struct({ maxGroups: PositiveInteger, maxMembersPerGroup: PositiveInteger }),
  ),
  identityCeilings: Schema.optional(IdentityCeilings),
  jurisdiction: Schema.Literals(["default", "eu", "fedramp"]),
  githubApp: Schema.optional(
    Schema.Struct({
      appId: PositiveInteger,
      clientId: Schema.NonEmptyString,
      slug: Schema.NonEmptyString,
    }),
  ),
  limits: Schema.Struct({
    artifactRetentionDays: PositiveInteger,
    maxArtifactBytes: Schema.optional(PositiveInteger),
    maxDirectUploadBytes: Schema.optional(PositiveInteger),
    cpuMs: Schema.optional(PositiveInteger),
  }),
  /** Optional organization-ID sampling probabilities. Omitted organizations send every event. */
  analyticsSampleRates: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
    ),
  ),
  features: Schema.Struct({
    edgeCache: Schema.Boolean,
    /** Opt-in only: accepts TURBO_TOKEN with legacy team namespaces. */
    legacyToken: Schema.optional(Schema.Boolean),
    emailSending: Schema.optional(Schema.Boolean),
    analytics: Schema.optional(Schema.Boolean),
    auditHistory: Schema.optional(Schema.Boolean),
    directUploads: Schema.optional(Schema.Boolean),
  }),
  /** Explicit operator assertion when billing permissions are unavailable. Never inferred from zone tier. */
  workersPlan: Schema.optional(Schema.Literals(["free", "paid"])),
  stages: Schema.Struct({ production: StageName, staging: StageName }),
});

export type DeployConfig = typeof DeployConfigSchema.Type;

const decodeDeployConfig = Schema.decodeUnknownSync(DeployConfigSchema);

export const defineDeployConfig = (input: DeployConfig): DeployConfig => {
  const config = decodeDeployConfig(input);

  if (config.stages.production === config.stages.staging) {
    throw new Error("Production and staging must use different stage names");
  }

  if (config.domain && config.domain === config.stagingDomain) {
    throw new Error("Production and staging must use different domains");
  }

  if (config.email !== undefined) {
    const senderDomain = config.email.from.split("@")[1] ?? "";

    if (
      !config.domain ||
      !(config.domain === senderDomain || config.domain.endsWith(`.${senderDomain}`))
    )
      throw new Error("Email sender must belong to the configured custom domain zone");
  }

  return config;
};

export const workerDomain = (config: DeployConfig, stage: string) =>
  stage === config.stages.production
    ? config.domain
    : stage === config.stages.staging
      ? config.stagingDomain
      : undefined;
