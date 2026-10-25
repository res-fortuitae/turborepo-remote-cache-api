import { RateLimiter, type RateBucket } from "@repo/ratelimit";
import { Effect } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { ApiError, type ArtifactScope } from "./api.ts";

const check = (key: string, bucket: RateBucket) =>
  RateLimiter.use((limiter) => limiter.check(key, bucket)).pipe(
    Effect.catchTags({
      RateLimited: (error) =>
        Effect.fail(
          new ApiError({
            status: 429,
            code: "rate_limited",
            message: "Too many requests",
            retryAfter: error.retryAfter,
          }),
        ),
      RateLimitUnavailable: () =>
        Effect.fail(
          new ApiError({ status: 503, code: "unavailable", message: "Rate limiter unavailable" }),
        ),
    }),
  );

export const cacheCredentialGuard = (scope: ArtifactScope) =>
  check(
    // No bearer value is ever placed in a counter key.
    scope.credential
      ? JSON.stringify([scope.credential.credentialType, scope.credential.credentialId])
      : "legacy",
    { name: "cache-credential", limit: scope.requestsPerMinute ?? 600, period: 60 },
  );

const ipGuard = (name: string, limit: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Cloudflare overwrites this header; never trust client-supplied X-Forwarded-For.
    yield* check(request.headers["cf-connecting-ip"] ?? "unknown", { name, limit, period: 60 });
  });

export const cacheAuthenticationFailureGuard = ipGuard("cache-auth-failure", 30);
export const oidcExchangeGuard = ipGuard("oidc-exchange", 30);
