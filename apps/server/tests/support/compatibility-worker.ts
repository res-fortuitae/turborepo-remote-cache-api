/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Local workerd contract-preview entry point. */
import type { R2Bucket } from "@cloudflare/workers-types";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Redacted, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi, type ArtifactBucket } from "../../src/api.ts";
import { createArtifactCache } from "../../src/edge-cache.ts";
import { uploadChunked } from "../../src/chunked-upload.ts";

/** Production API in workerd + real local R2. Test auth uses an ephemeral legacy token. */
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket; TOKEN: string }) {
    const bucket: ArtifactBucket = {
      head: (key) => Effect.tryPromise(() => env.BUCKET.head(key)),
      get: (key) =>
        Effect.tryPromise(async () => {
          const object = await env.BUCKET.get(key);
          return object
            ? {
                size: object.size,
                customMetadata: object.customMetadata,
                body: Stream.make(new Uint8Array(await object.arrayBuffer())),
              }
            : null;
        }),
      delete: (keys) => Effect.tryPromise(() => env.BUCKET.delete(keys)),
      // This fixture alone buffers tiny artifacts. Production uploads use the streaming adapter.
      put: (key, value, options) =>
        Stream.runCollect(value).pipe(
          Effect.flatMap((chunks) =>
            Effect.tryPromise(async () => {
              const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
              const bytes = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return env.BUCKET.put(key, bytes, options);
            }),
          ),
        ),
    };
    return artifactApi({
      uploadChunked: (key, body, options) => uploadChunked(env.BUCKET, key, body, options),
      bucket,
      token: Redacted.make(env.TOKEN),
      legacyTokenEnabled: true,
      maxUploadBytes: 12 * 1024 * 1024,
      edgeCacheEnabled: false,
      cache: createArtifactCache(false),
      waitUntil: () => Effect.void,
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(CanonicalOrigin, new URL(request.url).origin),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );
  },
};
