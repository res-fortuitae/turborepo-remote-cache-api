/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes the HTTP boundary. */
import { expect, test } from "bun:test";
import { RateLimiter, RateLimiterTest, RateLimitUnavailable } from "@repo/ratelimit";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Layer, Redacted, Result } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi } from "../src/api.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { cacheCredentialGuard, oidcExchangeGuard } from "../src/request-guards.ts";
import { memoryBucket } from "./support/in-process.ts";

test("OIDC exchange IP budget is shared across requests and returns a retry delay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 30; i++) yield* oidcExchangeGuard;
      const result = yield* Effect.result(oidcExchangeGuard);
      expect(Result.isFailure(result) && result.failure.status).toBe(429);
      expect(Result.isFailure(result) && result.failure.retryAfter).toBe(60);
    }).pipe(
      Effect.provide(RateLimiterTest),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("https://cache.test/oidc/exchange", {
            headers: { "cf-connecting-ip": "192.0.2.1" },
          }),
        ),
      ),
    ),
  ));

test("an unavailable credential limiter returns 503 before accessing R2", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const bucket = memoryBucket();

      const api = artifactApi({
        bucket: {
          ...bucket,
          head: (key) => {
            reads++;

            return bucket.head(key);
          },
        },
        token: Redacted.make("legacy"),
        legacyTokenEnabled: true,
        edgeCacheEnabled: false,
        cache: createArtifactCache(false),
        guard: cacheCredentialGuard,
        waitUntil: () => Effect.void,
      });

      const response = yield* api.pipe(
        Effect.provideService(CanonicalOrigin, "https://cache.test"),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://cache.test/v8/artifacts/abc", {
              method: "HEAD",
              headers: { authorization: "Bearer legacy" },
            }),
          ),
        ),
        Effect.map(HttpServerResponse.toWeb),
      );

      expect(response.status).toBe(503);
      expect(reads).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.succeed(RateLimiter, {
          check: () => Effect.fail(new RateLimitUnavailable({ cause: "down" })),
        }),
      ),
    ),
  ));
