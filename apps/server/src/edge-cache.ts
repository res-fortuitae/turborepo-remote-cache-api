import {
  ArtifactCacheStorage,
  EdgeCache,
  EdgeCacheLive,
  type ArtifactCache,
} from "@repo/artifacts";
import { Effect, Layer } from "effect";

/** Host-only adapter: domains never discover global bindings. */
export const createArtifactCache = (enabled: boolean): typeof EdgeCache.Service => {
  const layer = EdgeCacheLive.pipe(
    Layer.provide(
      Layer.sync(ArtifactCacheStorage, () => {
        // SAFETY: Workers supplies this optional Cache API; Bun may omit it.
        const storage = (globalThis as { caches?: { open(name: string): Promise<ArtifactCache> } })
          .caches;

        return { open: enabled && storage ? () => storage.open("turbo-artifacts") : undefined };
      }),
    ),
  );

  return {
    cacheControl: enabled ? "public, max-age=3600" : "no-store",
    match: (prefix, hash, generation) =>
      Effect.flatMap(EdgeCache, (cache) => cache.match(prefix, hash, generation)).pipe(
        Effect.provide(layer),
      ),
    put: (prefix, hash, response, generation) =>
      Effect.flatMap(EdgeCache, (cache) => cache.put(prefix, hash, response, generation)).pipe(
        Effect.provide(layer),
      ),
    remove: (prefix, hash, generation) =>
      Effect.flatMap(EdgeCache, (cache) => cache.remove(prefix, hash, generation)).pipe(
        Effect.provide(layer),
      ),
  };
};
