import * as Cloudflare from "alchemy/Cloudflare";
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
);

/** System of record: tenants, identities, credentials, audit and analytics rollups. */
export const Database = Cloudflare.D1.Database(
  "Database",
  planOnly(
    Effect.gen(function* () {
      const { jurisdiction } = yield* infraConfig;

      // Jurisdiction is fixed at creation; never add a location hint.
      return { jurisdiction };
    }),
  ),
);

/**
 * Caches only: auth secondary storage, JWKS, analytics drill-downs. Every
 * value must be rebuildable from D1, R2, or an upstream source (STV-483).
 */
export const CacheNamespace = Cloudflare.KV.Namespace("Cache");

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
  directory: new URL("../../../apps/dashboard/public", import.meta.url).pathname,
  notFoundHandling: "single-page-application",
  // Cache API paths never resolve to dashboard files.
  runWorkerFirst: ["/v8/*", "/api/*"],
} satisfies Cloudflare.AssetsProps;
