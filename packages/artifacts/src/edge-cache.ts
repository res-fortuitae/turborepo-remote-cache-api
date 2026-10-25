import { Context, Effect, Layer } from "effect";

export interface ArtifactCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Undefined disables caching, including in residency-restricted deployments. */
export class ArtifactCacheStorage extends Context.Service<
  ArtifactCacheStorage,
  {
    readonly open: (() => Promise<ArtifactCache>) | undefined;
  }
>()("@repo/artifacts/ArtifactCacheStorage") {}

export class EdgeCache extends Context.Service<
  EdgeCache,
  {
    readonly cacheControl: string;
    readonly match: (prefix: string, hash: string) => Effect.Effect<Response | undefined>;
    readonly put: (prefix: string, hash: string, response: Response) => Effect.Effect<void>;
    readonly remove: (prefix: string, hash: string) => Effect.Effect<void>;
  }
>()("@repo/artifacts/EdgeCache") {}

// Prefix contains the verified org AND project. Encode it as one path component.
const cacheKey = (prefix: string, hash: string) =>
  `https://artifact-cache.internal/${encodeURIComponent(prefix)}/${hash}`;

export const EdgeCacheLive = Layer.effect(
  EdgeCache,
  Effect.gen(function* () {
    const storage = yield* ArtifactCacheStorage;

    const attempt = <A>(f: (cache: ArtifactCache) => Promise<A>) =>
      storage.open
        ? Effect.tryPromise(async () => f(await storage.open!())).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.succeed(undefined);

    return {
      cacheControl: storage.open ? "public, max-age=3600" : "no-store",
      match: (prefix, hash) => attempt((cache) => cache.match(cacheKey(prefix, hash))),
      put: (prefix, hash, response) =>
        attempt((cache) => cache.put(cacheKey(prefix, hash), response)).pipe(Effect.asVoid),
      remove: (prefix, hash) =>
        attempt((cache) => cache.delete(cacheKey(prefix, hash))).pipe(Effect.asVoid),
    } satisfies typeof EdgeCache.Service;
  }),
);

export const EdgeCacheDisabled = Layer.succeed(EdgeCache, {
  cacheControl: "no-store",
  match: () => Effect.succeed(undefined),
  put: () => Effect.void,
  remove: () => Effect.void,
});

export const EdgeCacheTest = EdgeCacheLive.pipe(
  Layer.provide(
    Layer.sync(ArtifactCacheStorage, () => {
      const objects = new Map<
        string,
        { bytes: ArrayBuffer; status: number; headers: [string, string][] }
      >();

      return {
        open: async () => ({
          match: async (key) => {
            const entry = objects.get(key);

            return entry
              ? new Response(entry.bytes.slice(0), { status: entry.status, headers: entry.headers })
              : undefined;
          },
          put: async (key, response) => {
            objects.set(key, {
              bytes: await response.arrayBuffer(),
              status: response.status,
              headers: Array.from(response.headers),
            });
          },
          delete: async (key) => objects.delete(key),
        }),
      };
    }),
  ),
);
