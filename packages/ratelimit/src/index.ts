import { Clock, Context, Effect, Layer, Schema } from "effect";

export const RATE_LIMIT_TIERS = [1, 3, 10, 30, 60, 100, 300, 600] as const;

export interface RateBucket {
  readonly name: string;
  readonly limit: number;
  readonly period: 10 | 60;
}

/** Bindings have fixed thresholds. Round down, so requested limits never weaken. */
export const bindingLimit = (requested: number) =>
  RATE_LIMIT_TIERS.findLast((limit) => limit <= requested) ?? 1;

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfter: Schema.Number,
}) {}

export class RateLimitUnavailable extends Schema.TaggedError<RateLimitUnavailable>()(
  "RateLimitUnavailable",
  {
    cause: Schema.Unknown,
  },
) {}

/** Platform adapter captures request-independent clients, and resolves raw bindings per request. */
export class RateLimitBinding extends Context.Service<
  RateLimitBinding,
  {
    readonly stage: string;
    readonly limit: (
      key: string,
      bucket: RateBucket,
    ) => Effect.Effect<{ readonly success: boolean }, unknown>;
  }
>()("@repo/ratelimit/RateLimitBinding") {}

export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    readonly check: (
      key: string,
      bucket: RateBucket,
    ) => Effect.Effect<void, RateLimited | RateLimitUnavailable>;
  }
>()("@repo/ratelimit/RateLimiter") {}

export const RateLimiterLive = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const binding = yield* RateLimitBinding;

    return {
      check: Effect.fn("RateLimiter.check")(function* (key: string, bucket: RateBucket) {
        if (bucket.limit <= 0) return yield* new RateLimited({ retryAfter: bucket.period });
        const result = yield* binding
          .limit(JSON.stringify([binding.stage, bucket.name, key]), {
            ...bucket,
            limit: bindingLimit(bucket.limit),
          })
          .pipe(Effect.mapError((cause) => new RateLimitUnavailable({ cause })));

        if (!result.success) return yield* new RateLimited({ retryAfter: bucket.period });
      }),
    } satisfies typeof RateLimiter.Service;
  }),
);

/** Deterministic fixed windows; production counters are approximate and per location. */
export const RateLimiterTest = RateLimiterLive.pipe(
  Layer.provide(
    Layer.effect(
      RateLimitBinding,
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const windows = new Map<string, { count: number; started: number }>();

        return {
          stage: "test",
          limit: (key, bucket) =>
            Effect.gen(function* () {
              const now = yield* clock.currentTimeMillis;
              const id = JSON.stringify([bucket.period, key]);
              const prior = windows.get(id);

              const window =
                prior && now - prior.started < bucket.period * 1000
                  ? prior
                  : { count: 0, started: now };

              windows.set(id, window);

              if (window.count >= bucket.limit) return { success: false };
              window.count++;

              return { success: true };
            }),
        } satisfies typeof RateLimitBinding.Service;
      }),
    ),
  ),
);

/** Better Auth's atomic storage port. Server-side auth.api calls do not use it. */
export const betterAuthRateLimitStorage = (limiter: typeof RateLimiter.Service) => ({
  consume: (key: string, rule: { window: number; max: number }) =>
    Effect.runPromise(
      (rule.window > 60
        ? Effect.fail(new RateLimitUnavailable({ cause: "Unsupported rate window" }))
        : limiter.check(key, {
            name: "better-auth",
            // Round unsupported windows up; never reduce protection on plugin endpoints.
            period: rule.window <= 10 ? 10 : 60,
            limit: rule.max,
          })
      ).pipe(
        Effect.as({ allowed: true, retryAfter: null }),
        Effect.catchTag("RateLimited", (error) =>
          Effect.succeed({ allowed: false, retryAfter: error.retryAfter }),
        ),
      ),
    ),
});

/** Exchange-level IP/organization quotas retain their boolean domain port. */
export class ExchangeRateLimiter extends Context.Service<
  ExchangeRateLimiter,
  { readonly allow: (key: string) => Effect.Effect<boolean, RateLimitUnavailable> }
>()("@repo/ratelimit/ExchangeRateLimiter") {}

export const ExchangeRateLimiterTest = Layer.succeed(ExchangeRateLimiter, {
  allow: () => Effect.succeed(true),
});
