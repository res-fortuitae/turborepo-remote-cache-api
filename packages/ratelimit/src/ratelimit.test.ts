/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes Effects at this test boundary. */
import { expect, test } from "bun:test";
import { Effect, Layer, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  RateLimiter,
  RateLimiterLive,
  RateLimiterTest,
  RateLimitBinding,
  betterAuthRateLimitStorage,
} from "./index.ts";

test("windows, keys, buckets, builds and policy tiers are isolated correctly", async () => {
  for (let build = 0; build < 2; build++)
    await Effect.runPromise(
      Effect.gen(function* () {
        const limiter = yield* RateLimiter;
        const bucket = { name: "credential", limit: 3, period: 60 as const };
        expect(
          Result.isFailure(yield* Effect.result(limiter.check("zero", { ...bucket, limit: 0 }))),
        ).toBe(true);

        for (let i = 0; i < 3; i++) yield* limiter.check("a", bucket);
        const denied = yield* Effect.result(limiter.check("a", bucket));
        expect(Result.isFailure(denied) && denied.failure._tag).toBe("RateLimited");
        expect(
          Result.isFailure(denied) && "retryAfter" in denied.failure && denied.failure.retryAfter,
        ).toBe(60);
        yield* limiter.check("b", bucket);
        yield* limiter.check("a", { ...bucket, name: "auth" });
        // A tightened threshold shares the same counter; it cannot reset the count.
        expect(
          Result.isFailure(yield* Effect.result(limiter.check("a", { ...bucket, limit: 1 }))),
        ).toBe(true);
        yield* TestClock.adjust(60_000);
        yield* limiter.check("a", bucket);
      }).pipe(Effect.provide(RateLimiterTest.pipe(Layer.provideMerge(TestClock.layer())))),
    );
});

test("live binding namespaces stable keys and fails closed on outages", async () => {
  const calls: { key: string; limit: number; period: number }[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      yield* limiter.check("credential-id", { name: "credential", limit: 99, period: 60 });

      const failed = yield* Effect.result(
        limiter.check("down", { name: "auth", limit: 3, period: 10 }),
      );

      expect(Result.isFailure(failed) && failed.failure._tag).toBe("RateLimitUnavailable");
    }).pipe(
      Effect.provide(
        RateLimiterLive.pipe(
          Layer.provide(
            Layer.succeed(RateLimitBinding, {
              stage: "staging",
              limit: (key, bucket) => {
                calls.push({ key, limit: bucket.limit, period: bucket.period });

                return key.includes("down")
                  ? Effect.fail("unavailable")
                  : Effect.succeed({ success: true });
              },
            }),
          ),
        ),
      ),
    ),
  );
  expect(calls[0]).toEqual({
    key: JSON.stringify(["staging", "credential", "credential-id"]),
    limit: 60,
    period: 60,
  });
});

test("Better Auth atomic consume preserves strict rules without get/set counters", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = betterAuthRateLimitStorage(yield* RateLimiter);

      for (let i = 0; i < 3; i++)
        expect(
          yield* Effect.promise(() => storage.consume("ip/path", { max: 3, window: 10 })),
        ).toEqual({ allowed: true, retryAfter: null });
      expect(
        yield* Effect.promise(() => storage.consume("ip/path", { max: 3, window: 10 })),
      ).toEqual({ allowed: false, retryAfter: 10 });
      yield* TestClock.adjust(10_000);
      expect(
        (yield* Effect.promise(() => storage.consume("ip/path", { max: 3, window: 10 }))).allowed,
      ).toBe(true);
    }).pipe(Effect.provide(RateLimiterTest.pipe(Layer.provideMerge(TestClock.layer())))),
  ));
