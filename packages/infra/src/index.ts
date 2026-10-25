import { AuditEvent } from "@repo/api-spec";
import { AlchemyContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export interface InfraSettings {
  readonly stage: string;
  /** Applied to every bucket and to D1 at creation. Undefined means automatic. */
  readonly jurisdiction: "eu" | "fedramp" | undefined;
  readonly artifactRetentionDays: number;
  readonly auditHistoryEnabled?: boolean;
}

/**
 * Build-time inputs, resolved from deploy.config.ts by the root composition.
 * A Reference rather than a Service: the Worker yields these resources in its
 * init phase, which Alchemy also runs in the runtime where nothing provides it.
 */
export const InfraConfig = Context.Reference<InfraSettings | undefined>("@repo/infra/InfraConfig", {
  defaultValue: () => undefined,
});

const infraConfig = Effect.gen(function* () {
  const config = yield* InfraConfig;

  if (config === undefined) {
    return yield* Effect.die(new Error("InfraConfig must be provided by alchemy.run.ts"));
  }

  return config;
});

const DAY_SECONDS = 60 * 60 * 24;

/** Only explicitly named preview/PR stages are disposable; unknown stages fail closed. */
export const retainStatefulResources = (
  stage: string,
  stages: { readonly production: string; readonly staging: string },
) =>
  RemovalPolicy.retain(
    stage === stages.production ||
      stage === stages.staging ||
      !/^(?:preview-.+|pr-\d+(?:-.+)?)$/.test(stage),
  );

/**
 * Resource props are evaluated in the deployed Worker too, where neither
 * deploy.config.ts nor the deploy environment exists. Only bindings' logical
 * ids matter there, so props resolve to an empty placeholder.
 */
const planOnly = <A, R>(props: Effect.Effect<A, never, R>) =>
  Effect.suspend(() =>
    globalThis.__ALCHEMY_RUNTIME__
      ? // SAFETY: Alchemy ignores resource props inside the Worker runtime.
        Effect.succeed({} as A)
      : props,
  );

/** R2 bucket holding Turborepo cache artifacts, keyed by `<team>/<hash>`. */
export const ArtifactBucket = Cloudflare.R2.Bucket(
  "Artifacts",
  planOnly(
    Effect.gen(function* () {
      const config = yield* infraConfig;

      return {
        jurisdiction: config.jurisdiction,
        lifecycleRules: [
          {
            id: "expire-old-artifacts",
            deleteObjectsTransition: {
              condition: {
                type: "Age" as const,
                maxAge: DAY_SECONDS * config.artifactRetentionDays,
              },
            },
          },
          {
            id: "abort-stale-multipart-uploads",
            abortMultipartUploadsTransition: {
              condition: { type: "Age" as const, maxAge: DAY_SECONDS },
            },
          },
        ],
      };
    }),
  ),
).pipe(RemovalPolicy.destroy());

/** Reserved for operator backups; no automatic backup job is installed. */
export const BackupBucket = Cloudflare.R2.Bucket(
  "Backups",
  planOnly(Effect.map(infraConfig, ({ jurisdiction }) => ({ jurisdiction }))),
);

/** Checkpoints outlive the D1 window and the audit stream's own compaction. */
export const AUDIT_CHECKPOINT_RETENTION_DAYS = 400;

/**
 * Daily audit chain checkpoints (STV-482). Separate from the audit Iceberg
 * catalog, whose compaction rewrites files. The lock makes every object under
 * `checkpoints/` write-once for the retention period, whoever signs the request.
 */
export const AuditCheckpointBucket = Cloudflare.R2.Bucket(
  "AuditCheckpoints",
  planOnly(
    Effect.gen(function* () {
      const { jurisdiction } = yield* infraConfig;

      return {
        jurisdiction,
        locks: [
          {
            id: "checkpoints-write-once",
            enabled: true,
            prefix: "checkpoints/",
            condition: {
              type: "Age" as const,
              maxAgeSeconds: DAY_SECONDS * AUDIT_CHECKPOINT_RETENTION_DAYS,
            },
          },
        ],
      };
    }),
  ),
);

/** Audit events ingested by Basin Pipelines (STV-459). Records are validated against `AuditEvent`. */
export const AuditStream = Cloudflare.Basin.Stream("AuditStream", { schema: AuditEvent });

/**
 * Whether this deployment exports audit events to Basin. Basin Catalog needs
 * the default jurisdiction, and the sink needs a catalog API token.
 */
export const auditBasinEnabled = (settings: {
  readonly dev: boolean;
  readonly jurisdiction: string | undefined;
  readonly catalogToken: boolean;
}) => !settings.dev && settings.jurisdiction === undefined && settings.catalogToken;

/** Iceberg catalog storage for audit only, so its access and retention stay separate from analytics. */
const AuditCatalogBucket = Cloudflare.R2.Bucket("AuditCatalog", {});

const planAuditBasin = Effect.gen(function* () {
  const { dev } = yield* AlchemyContext;

  // Basin's resource providers are cloud-only. Never provision them during dev.
  if (dev) return Option.none();

  const { jurisdiction, auditHistoryEnabled } = yield* infraConfig;

  if (auditHistoryEnabled !== true) return Option.none();
  const token = yield* Config.option(Config.Redacted("BASIN_CATALOG_TOKEN")).pipe(Effect.orDie);

  if (Option.isNone(token) || !auditBasinEnabled({ dev, jurisdiction, catalogToken: true }))
    return Option.none();

  const bucket = yield* AuditCatalogBucket;

  // Resource FQNs are unique across types; keep the existing bucket's ID.
  const catalog = yield* Cloudflare.Basin.Catalog("AuditDataCatalog", {
    bucket,
    compaction: { state: "enabled", targetSizeMb: "128" },
    snapshotExpiration: { state: "enabled", maxSnapshotAge: "7d", minSnapshotsToKeep: 10 },
  });

  const stream = yield* AuditStream;

  // Cloudflare creates `audit.audit_log` with the sink. Kept forever; see ADR 0005.
  const sink = yield* Cloudflare.Basin.Sink("AuditLogTable", {
    type: "basin_catalog",
    catalog,
    table: { namespace: "audit", name: "audit_log" },
    token: token.value,
  });

  // Validation only: the stream schema rejects malformed records.
  yield* Cloudflare.Basin.Pipeline("AuditPipeline", {
    sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
  });

  return Option.some(stream);
});

/**
 * The audit stream, or none where Basin export is disabled. Inside the Worker
 * it is always the declaration; the Worker checks `AUDIT_STREAM_ENABLED`.
 */
export const AuditBasin = Effect.suspend(() =>
  globalThis.__ALCHEMY_RUNTIME__ ? Effect.map(AuditStream, Option.some) : planAuditBasin,
);

/** System of record: tenants, identities, credentials, audit and analytics rollups. */
export const Database = Cloudflare.D1.Database(
  "Database",
  planOnly(
    Effect.gen(function* () {
      const { jurisdiction } = yield* infraConfig;

      // Jurisdiction is fixed at creation; never add a location hint.
      return {
        jurisdiction,
        // Root scripts own the working directory; keep persisted migration paths portable.
        migrations: "./packages/db/migrations",
      };
    }),
  ),
);

/**
 * Caches only: auth secondary storage, JWKS, analytics drill-downs. Every
 * value must be rebuildable from D1, R2, or an upstream source (STV-483).
 */
export const CacheNamespace = Cloudflare.KV.Namespace("Cache").pipe(RemovalPolicy.destroy());

/** Cloudflare allows one Secrets Store per account; Alchemy adopts it and never deletes it. */
export const SecretStore = Cloudflare.SecretsStore.Store("SecretStore");

/**
 * The store is shared by every stage in the account, so secret names carry
 * the stage. Values come from the deploy environment (root `.env` or CI).
 */
const storeSecret = Effect.fn("Infra.storeSecret")(function* (
  variable: string,
  value: Redacted.Redacted<string>,
) {
  const { stage } = yield* infraConfig;
  const store = yield* SecretStore;

  return { store, name: `${stage}_${variable}`, value };
});

const requiredSecret = (id: string, variable: string) =>
  Cloudflare.SecretsStore.Secret(
    id,
    planOnly(
      Config.Redacted(variable).pipe(
        Effect.orDie,
        Effect.flatMap((value) => storeSecret(variable, value)),
      ),
    ),
  );

/**
 * Secrets whose feature may not be configured yet. Planning skips them when
 * the variable is unset; the runtime declaration only names the binding.
 */
const optionalSecret = (id: string, variable: string) =>
  Effect.suspend(() =>
    globalThis.__ALCHEMY_RUNTIME__
      ? Effect.map(requiredSecret(id, variable), Option.some)
      : Config.option(Config.Redacted(variable)).pipe(
          Effect.orDie,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (value) =>
                Effect.map(
                  Cloudflare.SecretsStore.Secret(id, storeSecret(variable, value)),
                  Option.some,
                ),
            }),
          ),
        ),
  );

/** Current cache-token signing key. Rotation (STV-445) adds versioned keys alongside it. */
export const SigningKey = requiredSecret("SigningKey", "CACHE_TOKEN_SIGNING_KEY");

export const BetterAuthSecret = requiredSecret("BetterAuthSecret", "BETTER_AUTH_SECRET");

export const GitHubOAuthSecret = optionalSecret("GitHubOAuthSecret", "GITHUB_OAUTH_CLIENT_SECRET");

/** Basin is unavailable in restricted jurisdictions; the token stays unset there. */
export const R2LifecycleToken = optionalSecret("R2LifecycleToken", "R2_LIFECYCLE_API_TOKEN");

export const BasinSqlToken = optionalSecret("BasinSqlToken", "BASIN_SQL_TOKEN");

/**
 * Account-wide limiter namespace shared by every stage; consumers prefix
 * keys with the stage when isolation matters. Ceilings are enforced by
 * `@repo/ratelimit` (STV-446).
 */
export const RateLimiter = Cloudflare.RateLimit("RATE_LIMITER", {
  namespaceId: 4280,
  simple: { limit: 600, period: 60 },
});

/** Dashboard build output, served by the API Worker ahead of its fetch handler. */
export const DashboardAssets = {
  directory: new URL("../../../apps/dashboard/dist", import.meta.url).pathname,
  notFoundHandling: "single-page-application",
  // Cache API paths never resolve to dashboard files.
  runWorkerFirst: ["/v8", "/v8/*", "/api", "/api/*", "/oidc", "/oidc/*", "/.well-known/*"],
} satisfies Cloudflare.AssetsProps;

export {
  detectCapabilities,
  resolveCapabilities,
  workersPlanFromSubscriptions,
} from "./capabilities.ts";

export type { CapabilityInputs } from "./capabilities.ts";

/** Worker binding only; domain onboarding is an explicit operator step. */
export const TransactionalEmail = Cloudflare.Email.SendEmail("TransactionalEmail");
