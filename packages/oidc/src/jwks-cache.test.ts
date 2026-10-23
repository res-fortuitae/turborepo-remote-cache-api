import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { type Jwks, JwksCache, JwksCacheLive, JwksCacheTest, KvNamespace } from "./jwks-cache.ts";

const keys = (kid: string): Jwks => ({ keys: [{ kid, kty: "RSA" }] });

const counting = (jwks: Jwks) => {
  let calls = 0;

  return { load: Effect.sync(() => (calls++, jwks)), calls: () => calls };
};

const run = <A, E>(program: Effect.Effect<A, E, JwksCache>, layer = JwksCacheTest) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(Effect.provide(program, layer));

describe("JwksCache", () => {
  test("loads on a miss, then serves from KV per issuer", async () => {
    const github = counting(keys("a"));
    const gitlab = counting(keys("b"));

    await run(
      Effect.gen(function* () {
        const cache = yield* JwksCache;
        expect(yield* cache.get("https://github", github.load)).toEqual(keys("a"));
        expect(yield* cache.get("https://github", github.load)).toEqual(keys("a"));
        expect(yield* cache.get("https://gitlab", gitlab.load)).toEqual(keys("b"));
      }),
    );

    expect([github.calls(), gitlab.calls()]).toEqual([1, 1]);
  });

  test("refresh replaces cached keys after rotation", async () => {
    await run(
      Effect.gen(function* () {
        const cache = yield* JwksCache;
        yield* cache.get("https://github", Effect.succeed(keys("old")));
        yield* cache.refresh("https://github", Effect.succeed(keys("new")));
        expect(yield* cache.get("https://github", Effect.die("unused"))).toEqual(keys("new"));
      }),
    );
  });

  test("load failures propagate and are not cached", async () => {
    const result = await run(
      Effect.gen(function* () {
        const cache = yield* JwksCache;
        const failed = yield* cache.get("https://github", Effect.fail("offline")).pipe(Effect.flip);
        expect(failed).toBe("offline");

        return yield* cache.get("https://github", Effect.succeed(keys("a")));
      }),
    );

    expect(result).toEqual(keys("a"));
  });

  test("KV errors and corrupt values degrade to the issuer", async () => {
    const broken = Layer.succeed(KvNamespace, {
      get: async () => "not json",
      put: async () => {
        throw new Error("429 too many writes");
      },
    });

    const issuer = counting(keys("a"));

    await run(
      Effect.gen(function* () {
        const cache = yield* JwksCache;
        expect(yield* cache.get("https://github", issuer.load)).toEqual(keys("a"));
        expect(yield* cache.get("https://github", issuer.load)).toEqual(keys("a"));
      }),
      JwksCacheLive.pipe(Layer.provide(broken)),
    );

    expect(issuer.calls()).toBe(2);
  });
});
