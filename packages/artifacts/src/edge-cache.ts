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
    readonly match: (
      prefix: string,
      hash: string,
      generation?: number,
    ) => Effect.Effect<Response | undefined>;
    readonly put: (
      prefix: string,
      hash: string,
      response: Response,
      generation?: number,
    ) => Effect.Effect<void>;
    readonly remove: (prefix: string, hash: string, generation?: number) => Effect.Effect<void>;
  }
>()("@repo/artifacts/EdgeCache") {}

// Scope is verified before use; generation changes invalidate all locations.
const cacheKey = (prefix: string, hash: string, generation = 0) =>
  `https://artifact-cache.internal/${prefix.split("/").map(encodeURIComponent).join("/")}/g${generation}/${hash}`;

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
      match: (prefix, hash, generation) =>
        attempt((cache) => cache.match(cacheKey(prefix, hash, generation))),
      put: (prefix, hash, response, generation) =>
        attempt((cache) => cache.put(cacheKey(prefix, hash, generation), response)).pipe(
          Effect.asVoid,
        ),
      remove: (prefix, hash, generation) =>
        attempt((cache) => cache.delete(cacheKey(prefix, hash, generation))).pipe(Effect.asVoid),
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
