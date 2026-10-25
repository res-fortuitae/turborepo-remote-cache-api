import { Context, Effect, Layer, Schema } from "effect";

export class RateLimitUnavailable extends Schema.TaggedError<RateLimitUnavailable>()(
  "RateLimitUnavailable",
  {},
) {}

/** The host wraps its platform binding; domains never import infrastructure. */
export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    readonly allow: (key: string) => Effect.Effect<boolean, RateLimitUnavailable>;
  }
>()("@repo/ratelimit/RateLimiter") {}

/** Explicit test adapter; production must supply the native binding. */
export const RateLimiterTest = Layer.succeed(RateLimiter, { allow: () => Effect.succeed(true) });
