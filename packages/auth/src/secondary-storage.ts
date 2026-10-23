import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The subset of a Workers KV binding auth uses. KV is eventually consistent
 * (about 60 s) and has no atomic operations (STV-483), so it only caches
 * sessions that D1 also stores.
 */
export interface KvStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export class AuthKvNamespace extends Context.Service<AuthKvNamespace, KvStore>()(
  "@repo/auth/AuthKvNamespace",
) {}

export class SecondaryStorageError extends Schema.TaggedError<SecondaryStorageError>()(
  "SecondaryStorageError",
  { operation: Schema.String, cause: Schema.Unknown },
) {}

export interface SecondaryStorageService {
  /** A miss, a read failure and a corrupt value are all `None`; D1 is the fallback. */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>>;
  /** Write failures are logged; the D1 copy stays authoritative. */
  readonly set: (key: string, value: string, ttlSeconds?: number) => Effect.Effect<void>;
  /** Fails, so a revocation never silently leaves a cached session behind. */
  readonly delete: (key: string) => Effect.Effect<void, SecondaryStorageError>;
}

/**
 * Optional cache for Better Auth sessions. `AuthLive` uses it when present;
 * leave it out and every lookup reads D1.
 */
export class SecondaryStorage extends Context.Service<SecondaryStorage, SecondaryStorageService>()(
  "@repo/auth/SecondaryStorage",
) {}

/** KV rejects `expirationTtl` below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;
const KEY_PREFIX = "auth:";

export const SecondaryStorageLive: Layer.Layer<SecondaryStorage, never, AuthKvNamespace> =
  Layer.effect(
    SecondaryStorage,
    Effect.gen(function* () {
      const kv = yield* AuthKvNamespace;
      const key = (name: string) => `${KEY_PREFIX}${name}`;

      return {
        get: (name) =>
          Effect.tryPromise(() => kv.get(key(name))).pipe(
            Effect.map(Option.fromNullishOr),
            Effect.catch((cause) =>
              Effect.as(
                Effect.logWarning("SecondaryStorage read failed", cause),
                Option.none<string>(),
              ),
            ),
          ),
        set: (name, value, ttlSeconds) =>
          Effect.tryPromise(() =>
            kv.put(
              key(name),
              value,
              ttlSeconds === undefined || ttlSeconds <= 0
                ? undefined
                : { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds)) },
            ),
          ).pipe(
            Effect.catch((cause) => Effect.logWarning("SecondaryStorage write failed", cause)),
          ),
        delete: (name) =>
          Effect.tryPromise({
            try: () => kv.delete(key(name)),
            catch: (cause) => new SecondaryStorageError({ operation: "delete", cause }),
          }),
      } satisfies SecondaryStorageService;
    }),
  );

/** In-memory storage honouring TTLs against wall-clock time, fresh per layer build. */
export const SecondaryStorageTest: Layer.Layer<SecondaryStorage> = Layer.sync(
  SecondaryStorage,
  () => {
    const entries = new Map<string, { value: string; expiresAt: number | undefined }>();

    return {
      get: (name) =>
        Effect.sync(() => {
          const entry = entries.get(name);

          if (entry === undefined) return Option.none();

          if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
            entries.delete(name);

            return Option.none();
          }

          return Option.some(entry.value);
        }),
      set: (name, value, ttlSeconds) =>
        Effect.sync(() => {
          entries.set(name, {
            value,
            expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined,
          });
        }),
      delete: (name) =>
        Effect.sync(() => {
          entries.delete(name);
        }),
    } satisfies SecondaryStorageService;
  },
);
