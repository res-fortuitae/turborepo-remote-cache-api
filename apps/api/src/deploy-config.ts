import * as Schema from "effect/Schema";

const Hostname = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
);

const StageName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const DeployConfigSchema = Schema.Struct({
  domain: Schema.optional(Hostname),
  stagingDomain: Schema.optional(Hostname),
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
    cpuMs: Schema.optional(PositiveInteger),
  }),
  features: Schema.Struct({ edgeCache: Schema.Boolean }),
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

  return config;
};

export const workerDomain = (config: DeployConfig, stage: string) =>
  stage === config.stages.production
    ? config.domain
    : stage === config.stages.staging
      ? config.stagingDomain
      : undefined;
