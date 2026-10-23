import * as Effect from "effect/Effect";
import { residency } from "./deployment.ts";

/**
 * Per-datacenter copy of artifact downloads via the Workers Cache API.
 *
 * Lookups happen inside the Worker, after authentication, so a cached
 * artifact is never served to an unauthenticated client. Entries are keyed
 * by team + hash on a synthetic URL so the bearer token never forms part of
 * the key.
 */

const CACHE_NAME = "turbo-artifacts";
export const CACHE_CONTROL = residency.allowArtifactEdgeCache ? "public, max-age=3600" : "no-store";

interface ArtifactCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const open = (enabled: boolean) =>
  Effect.suspend(() => {
    if (!enabled) return Effect.succeed(undefined);

    // SAFETY: Workers supplies this optional Cache API; non-Worker runtimes may omit it.
    const storage = (globalThis as { caches?: { open(name: string): Promise<ArtifactCache> } })
      .caches;

    return storage ? Effect.promise(() => storage.open(CACHE_NAME)) : Effect.succeed(undefined);
  });

const cacheKey = (team: string, hash: string) =>
  `https://artifact-cache.internal/${encodeURIComponent(team)}/${hash}`;

/** Cache failures are never fatal: fall through to R2. */
const attempt = <A>(enabled: boolean, f: (cache: ArtifactCache) => Promise<A>) =>
  open(enabled).pipe(
    Effect.flatMap((cache) =>
      cache ? Effect.tryPromise(() => f(cache)) : Effect.succeed(undefined),
    ),
    Effect.orElseSucceed(() => undefined),
  );

export const createArtifactCache = (enabled: boolean) => ({
  match: (team: string, hash: string) =>
    attempt(enabled, (cache) => cache.match(cacheKey(team, hash))),
  put: (team: string, hash: string, response: Response) =>
    attempt(enabled, (cache) => cache.put(cacheKey(team, hash), response)),
  remove: (team: string, hash: string) =>
    attempt(enabled, (cache) => cache.delete(cacheKey(team, hash))),
});

export const { match, put, remove } = createArtifactCache(residency.allowArtifactEdgeCache);
