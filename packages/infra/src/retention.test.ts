import { expect, test } from "bun:test";
import { Providers } from "alchemy/Cloudflare";
import { Stack, type StackSpec } from "alchemy/Stack";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import {
  ArtifactBucket,
  AuditBasin,
  AuditCheckpointBucket,
  BackupBucket,
  BasinSqlToken,
  BetterAuthSecret,
  CacheNamespace,
  Database,
  GitHubOAuthSecret,
  InfraConfig,
  retainStatefulResources,
  SigningKey,
} from "./index.ts";

const stages = { production: "prod", staging: "staging" };

/** Compile real declarations only; fail if anything tries to use a cloud provider. */
const declarations = (stage: string, configuredStages = stages) => {
  const stack: Omit<StackSpec, "output"> = {
    name: "TurborepoRemoteCache",
    stage,
    resources: {},
    bindings: {},
    actions: {},
  };

  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Bun fixture compiles synchronous declarations only; no clocks, fibers, or cloud operations.
  Effect.runSync(
    Effect.gen(function* () {
      yield* ArtifactBucket;
      yield* Database;
      yield* CacheNamespace;
      yield* BackupBucket;
      yield* AuditCheckpointBucket;
      yield* AuditBasin;
      yield* SigningKey;
      yield* BetterAuthSecret;
      yield* GitHubOAuthSecret;
      yield* BasinSqlToken;
    }).pipe(
      retainStatefulResources(stage, configuredStages),
      Effect.provideService(Providers, {
        kind: "ProviderCollection",
        providers: {},
        get: () => {
          throw new Error("Declaration tests must not call cloud providers");
        },
      }),
      Effect.provideService(Stack, stack),
      Effect.provideService(InfraConfig, {
        stage,
        jurisdiction: undefined,
        artifactRetentionDays: 30,
      }),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          BASIN_CATALOG_TOKEN: "test-only",
          CACHE_TOKEN_SIGNING_KEY: "test-only",
          BETTER_AUTH_SECRET: "test-only",
          GITHUB_OAUTH_CLIENT_SECRET: "test-only",
          BASIN_SQL_TOKEN: "test-only",
        }),
      ),
    ),
  );

  return Object.fromEntries(
    Object.entries(stack.resources).map(([fqn, resource]) => [
      fqn,
      { type: resource.Type, policy: resource.RemovalPolicy },
    ]),
  );
};

// Persisted logical IDs and resource types are a release compatibility contract.
const protectedResources = {
  Database: "Cloudflare.D1Database",
  Backups: "Cloudflare.R2.Bucket",
  AuditCheckpoints: "Cloudflare.R2.Bucket",
  AuditCatalog: "Cloudflare.R2.Bucket",
  AuditDataCatalog: "Cloudflare.R2.DataCatalog",
  AuditStream: "Cloudflare.Pipelines.Stream",
  AuditLogTable: "Cloudflare.Pipelines.Sink",
  AuditPipeline: "Cloudflare.Pipelines.Pipeline",
  SecretStore: "Cloudflare.SecretsStore",
  SigningKey: "Cloudflare.SecretsStore.Secret",
  BetterAuthSecret: "Cloudflare.SecretsStore.Secret",
  GitHubOAuthSecret: "Cloudflare.SecretsStore.Secret",
  BasinSqlToken: "Cloudflare.SecretsStore.Secret",
};

const expectedResources = (policy: "retain" | "destroy") =>
  ({
    ...Object.fromEntries(
      Object.entries(protectedResources).map(([id, type]) => [id, { type, policy }]),
    ),
    Artifacts: { type: "Cloudflare.R2.Bucket", policy: "destroy" },
    Cache: { type: "Cloudflare.KV.Namespace", policy: "destroy" },
  }) satisfies Record<string, { type: string; policy: "retain" | "destroy" }>;

test.each(["prod", "staging", "dev", "test_user", "custom", "pr-", "pr-production", "preview"])(
  "%s retains persistent resources and keeps caches disposable",
  (stage) => {
    expect(declarations(stage)).toEqual(expectedResources("retain"));
  },
);

test.each(["pr-15", "pr-15-fix", "preview-feature", "preview-test_user"])(
  "%s permits preview cleanup",
  (stage) => {
    expect(declarations(stage)).toEqual(expectedResources("destroy"));
  },
);

test("configured production and staging remain protected even with preview names", () => {
  const configured = { production: "pr-15", staging: "preview-staging" };
  expect(declarations(configured.production, configured)).toEqual(expectedResources("retain"));
  expect(declarations(configured.staging, configured)).toEqual(expectedResources("retain"));
});
