// Local performance fixture: production cache routes, streaming R2 and multipart adapters.
// Synthetic scoped auth deliberately excludes D1 authorization/quotas and OIDC exchange.
import type { R2Bucket, ExecutionContext } from "@cloudflare/workers-types";
import { MultipartBucket, MultipartSecret, MultipartUploadsLive } from "@repo/artifacts";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Layer, Redacted, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ApiError, artifactApi, type ArtifactBucket, type ArtifactScope } from "../src/api.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { uploadChunked } from "../src/chunked-upload.ts";
import { makeMultipartBucket } from "../src/multipart-bucket.ts";
import { multipartRoute } from "../src/multipart-route.ts";
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket; TOKEN: string }, ctx: ExecutionContext) {
    const bucket: ArtifactBucket = {
      head: (key) => Effect.tryPromise(() => env.BUCKET.head(key)),
      get: (key) =>
        Effect.tryPromise(async () => {
          const object = await env.BUCKET.get(key);
          if (!object) return null;
          const reader = object.body.getReader();
          const readable = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = await reader.read();
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            },
            cancel: (reason) => reader.cancel(reason),
          });
          return {
            size: object.size,
            customMetadata: object.customMetadata,
            readable,
            body: Stream.fromReadableStream({ evaluate: () => readable, onError: (e) => e }),
          };
        }),
      delete: (keys) => Effect.tryPromise(() => env.BUCKET.delete(keys)),
      put: (key, body, options) =>
        uploadChunked(env.BUCKET, key, body, { ...options, maxBytes: 200_000_000 }),
    };
    const scope: ArtifactScope = {
      prefix: "benchmark/benchmark",
      maxUploadBytes: 200_000_000,
      cacheGeneration: 0,
      credential: {
        orgId: "benchmark",
        projectId: "benchmark",
        scopes: ["read", "write"],
        credentialType: "apiKey",
        credentialId: "benchmark",
        subject: "benchmark",
        principal: {
          org: "benchmark",
          project: "benchmark",
          scope: "read write",
          subject: "benchmark",
          tokenId: "benchmark",
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      },
    };
    const multipart = MultipartUploadsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(MultipartBucket, makeMultipartBucket(env.BUCKET)),
          Layer.succeed(MultipartSecret, Redacted.make(env.TOKEN)),
        ),
      ),
    );
    const cache = createArtifactCache(true);
    return artifactApi({
      bucket,
      token: Redacted.make(env.TOKEN),
      edgeCacheEnabled: true,
      cache,
      maxUploadBytes: 100_000_000,
      authorize: (token) =>
        token === env.TOKEN
          ? Effect.succeed(scope)
          : Effect.fail(
              new ApiError({
                status: 401,
                code: "unauthorized",
                message: "Invalid fixture credential",
              }),
            ),
      uploadChunked: (key, body, options) => uploadChunked(env.BUCKET, key, body, options),
      waitUntil: (effect) => Effect.sync(() => ctx.waitUntil(Effect.runPromise(effect))),
      multipart: (scope, recheck) =>
        multipartRoute(
          scope,
          recheck,
          () => Effect.void,
          (hash) => cache.remove(scope.prefix, hash, scope.cacheGeneration),
        ).pipe(
          Effect.provide(multipart),
          Effect.mapError((e) =>
            e instanceof ApiError
              ? e
              : new ApiError({
                  status: 503,
                  code: "storage",
                  message: "Fixture storage unavailable",
                }),
          ),
        ),
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
