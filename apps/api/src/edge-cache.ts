import * as Effect from "effect/Effect";

/**
 * Per-datacenter copy of artifact downloads via the Workers Cache API.
 *
 * Lookups happen inside the Worker, after authentication, so a cached
 * artifact is never served to an unauthenticated client. Entries are keyed
 * by team + hash on a synthetic URL so the bearer token never forms part of
 * the key.
 */

const CACHE_NAME = "turbo-artifacts";
export const CACHE_CONTROL = "public, max-age=3600";

interface ArtifactCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const open = Effect.suspend(() => {
  const storage = (globalThis as { caches?: { open(name: string): Promise<ArtifactCache> } })
    .caches;
  return storage ? Effect.promise(() => storage.open(CACHE_NAME)) : Effect.succeed(undefined);
});

const cacheKey = (team: string, hash: string) =>
  `https://artifact-cache.internal/${encodeURIComponent(team)}/${hash}`;

/** Cache failures are never fatal: fall through to R2. */
const attempt = <A>(f: (cache: ArtifactCache) => Promise<A>) =>
  open.pipe(
    Effect.flatMap((cache) =>
      cache ? Effect.tryPromise(() => f(cache)) : Effect.succeed(undefined),
    ),
    Effect.orElseSucceed(() => undefined),
  );

export const match = (team: string, hash: string) =>
  attempt((cache) => cache.match(cacheKey(team, hash)));

export const put = (team: string, hash: string, response: Response) =>
  attempt((cache) => cache.put(cacheKey(team, hash), response));

export const remove = (team: string, hash: string) =>
  attempt((cache) => cache.delete(cacheKey(team, hash)));
