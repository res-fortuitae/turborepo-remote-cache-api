import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The subset of a Workers KV binding the caches use. KV is eventually
 * consistent and allows about one write per second per key (STV-483), so it
 * only ever holds values that can be refetched.
 */
export interface KvStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (key: string, value: string, options: { expirationTtl: number }) => Promise<void>;
}

export class KvNamespace extends Context.Service<KvNamespace, KvStore>()(
  "@repo/oidc/KvNamespace",
) {}

export const Jwks = Schema.Struct({
  keys: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ kty: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
});

export type Jwks = typeof Jwks.Type;

const JwksJson = Schema.fromJsonString(Jwks);
const decodeCached = Schema.decodeUnknownOption(JwksJson);
const encode = Schema.encodeSync(JwksJson);

/** Issuers rotate keys rarely; `refresh` covers an unknown `kid` sooner. */
export const JWKS_TTL_SECONDS = 60 * 60;

export interface JwksCacheService {
  /** Cached keys for `issuer`, or `load`'s result on a miss. */
  readonly get: <E>(issuer: string, load: Effect.Effect<Jwks, E>) => Effect.Effect<Jwks, E>;
  /** Reloads and re-caches, e.g. when a token names a `kid` the cached set lacks. */
  readonly refresh: <E>(issuer: string, load: Effect.Effect<Jwks, E>) => Effect.Effect<Jwks, E>;
}

export class JwksCache extends Context.Service<JwksCache, JwksCacheService>()(
  "@repo/oidc/JwksCache",
) {}

/** KV failures degrade to a cache miss; the issuer stays the source of truth. */
export const JwksCacheLive: Layer.Layer<JwksCache, never, KvNamespace> = Layer.effect(
  JwksCache,
  Effect.gen(function* () {
    const kv = yield* KvNamespace;
    const key = (issuer: string) => `jwks:${issuer}`;

    const read = (issuer: string) =>
      Effect.tryPromise(() => kv.get(key(issuer))).pipe(
        Effect.map((value) => (value === null ? Option.none() : decodeCached(value))),
        Effect.catch((cause) =>
          Effect.as(Effect.logWarning("JwksCache read failed", cause), Option.none<Jwks>()),
        ),
      );

    const write = (issuer: string, jwks: Jwks) =>
      Effect.tryPromise(() =>
        kv.put(key(issuer), encode(jwks), { expirationTtl: JWKS_TTL_SECONDS }),
      ).pipe(Effect.catch((cause) => Effect.logWarning("JwksCache write failed", cause)));

    const refresh = <E>(issuer: string, load: Effect.Effect<Jwks, E>) =>
      Effect.tap(load, (jwks) => write(issuer, jwks));

    return {
      get: (issuer, load) =>
        Effect.flatMap(
          read(issuer),
          Option.match({ onNone: () => refresh(issuer, load), onSome: Effect.succeed }),
        ),
      refresh,
    } satisfies JwksCacheService;
  }),
);

/** In-memory KV honouring `expirationTtl` against wall-clock time, fresh per layer build. */
export const KvNamespaceTest = Layer.sync(KvNamespace, () => {
  const entries = new Map<string, { readonly value: string; readonly expiresAt: number }>();

  return {
    get: async (key) => {
      const entry = entries.get(key);

      return entry !== undefined && entry.expiresAt > Date.now() ? entry.value : null;
    },
    put: async (key, value, { expirationTtl }) => {
      entries.set(key, { value, expiresAt: Date.now() + expirationTtl * 1000 });
    },
  };
});

export const JwksCacheTest = JwksCacheLive.pipe(Layer.provide(KvNamespaceTest));
