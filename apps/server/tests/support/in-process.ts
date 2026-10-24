/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Requests cross from Bun's fetch into the Effect handler at this test boundary. */
import * as Cloudflare from "alchemy/Cloudflare";
import { CanonicalOrigin } from "@repo/deploy-config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi, type ArtifactBucket, type StoredArtifact } from "../../src/api.ts";
import { createArtifactCache } from "../../src/edge-cache.ts";
import type { Target } from "./target.ts";

interface StoredObject extends StoredArtifact {
  readonly bytes: Uint8Array;
}

export interface MemoryBucket extends ArtifactBucket<never> {
  readonly objects: Map<string, StoredObject>;
  /** When set, every operation fails like an unavailable R2 binding. */
  failing: boolean;
}

/** Deterministic in-memory stand-in for the R2 binding; fresh per call. */
export const memoryBucket = (): MemoryBucket => {
  const objects = new Map<string, StoredObject>();

  const guard = <A>(effect: Effect.Effect<A>) =>
    Effect.suspend(() =>
      bucket.failing
        ? Effect.fail(
            new Cloudflare.R2.R2Error({ message: "unavailable", cause: new Error("unavailable") }),
          )
        : effect,
    );

  const bucket: MemoryBucket = {
    objects,
    failing: false,
    head: (key) => guard(Effect.sync(() => objects.get(key) ?? null)),
    get: (key) =>
      guard(
        Effect.sync(() => {
          const object = objects.get(key);

          return object ? { ...object, body: Stream.make(object.bytes) } : null;
        }),
      ),
    put: (key, value, options) =>
      guard(Effect.void).pipe(
        Effect.andThen(Stream.runCollect(value)),
        Effect.map((chunks) => {
          const bytes = new Uint8Array(Bun.concatArrayBuffers([...chunks]));
          const object = { size: bytes.byteLength, customMetadata: options.customMetadata, bytes };
          objects.set(key, object);

          return object;
        }),
      ),
  };

  return bucket;
};

export const inProcessHandler = (token: string, bucket: MemoryBucket = memoryBucket()) => {
  const api = artifactApi({
    bucket,
    token: Redacted.make(token),
    edgeCacheEnabled: false,
    cache: createArtifactCache(false),
    waitUntil: () => Effect.void,
  });

  return (request: Request) =>
    api.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(CanonicalOrigin, new URL(request.url).origin),
      Effect.map((response) => HttpServerResponse.toWeb(response)),
      Effect.runPromise,
    );
};

/** Dispatches requests straight to the handler, without a socket. */
export const inProcessTarget = (token: string, bucket?: MemoryBucket): Target => {
  const handle = inProcessHandler(token, bucket);

  return {
    token,
    fetch: async (path, init) => {
      const request = new Request(`http://localhost${path}`, init);

      if (request.body === null) return handle(request);

      // HTTP clients send Content-Length on the wire; a constructed Request does not.
      const body = await request.arrayBuffer();
      const headers = new Headers(request.headers);
      headers.set("content-length", String(body.byteLength));

      return handle(new Request(request.url, { method: request.method, headers, body }));
    },
  };
};

/** Serves the handler on a local port so real clients such as `turbo` can reach it. */
export const serveInProcess = (token: string) => {
  const handle = inProcessHandler(token);

  return Bun.serve({ port: 0, fetch: handle });
};
