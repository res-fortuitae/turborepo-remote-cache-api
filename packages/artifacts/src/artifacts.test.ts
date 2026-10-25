/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives domain Effects at this test boundary. */
import { CoordinatorClient, CoordinatorClientTest } from "@repo/coordinator";
import { expect, test } from "bun:test";
import { Effect, Layer, Result, Stream } from "effect";
import {
  ArtifactPurger,
  ArtifactPurgerLive,
  ArtifactStore,
  ArtifactStoreLive,
  ArtifactStoreTest,
  ArtifactCacheStorage,
  EdgeCache,
  EdgeCacheLive,
  EdgeCacheTest,
  R2Bucket,
} from "./index.ts";

const options = {
  contentLength: 1,
  httpMetadata: { contentType: "application/octet-stream" },
  customMetadata: { duration: "42" },
};

test("artifact Test layers isolate projects and builds, preserve metadata and stream bytes", async () => {
  for (let build = 0; build < 2; build++)
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ArtifactStore;
        expect(yield* store.head("org/a", "abc")).toBeNull();
        yield* store.put("org/a", "abc", Stream.make(new Uint8Array([65])), options);
        expect(yield* store.head("org/a", "abc")).toMatchObject({
          size: 1,
          customMetadata: { duration: "42" },
        });
        expect(yield* store.head("org/b", "abc")).toBeNull();
        const object = yield* store.get("org/a", "abc");
        expect(object).not.toBeNull();
        const chunks = yield* Stream.runCollect(object!.body);
        expect([...chunks[0]!]).toEqual([65]);
        yield* store.remove("org/a", "abc");
        expect(yield* store.get("org/a", "abc")).toBeNull();
      }).pipe(Effect.provide(ArtifactStoreTest)),
    );
});

test("bucket failures are typed; edge-cache failures fall back without failing requests", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ArtifactStore;
      const result = yield* Effect.result(store.head("org/p", "abc"));
      expect(Result.isFailure(result) && result.failure._tag).toBe("ArtifactStorageError");
      const cache = yield* EdgeCache;
      expect(yield* cache.match("org/p", "abc")).toBeUndefined();
      yield* cache.put("org/p", "abc", new Response("a"));
      yield* cache.remove("org/p", "abc");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ArtifactStoreLive.pipe(
            Layer.provide(
              Layer.succeed(R2Bucket, {
                head: () => Effect.fail("offline"),
                get: () => Effect.fail("offline"),
                put: () => Effect.fail("offline"),
                delete: () => Effect.fail("offline"),
              }),
            ),
          ),
          EdgeCacheLive.pipe(
            Layer.provide(
              Layer.succeed(ArtifactCacheStorage, {
                open: async () => {
                  throw new Error("offline");
                },
              }),
            ),
          ),
        ),
      ),
    ),
  ));

test("edge cache scopes identical hashes by organization/project and evicts only the selected project", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* EdgeCache;
      yield* cache.put("org/a", "abc", new Response("A"));
      yield* cache.put("org/b", "abc", new Response("B"));
      const a = yield* cache.match("org/a", "abc");
      const b = yield* cache.match("org/b", "abc");
      expect(yield* Effect.promise(() => a!.text())).toBe("A");
      expect(yield* Effect.promise(() => b!.text())).toBe("B");
      yield* cache.remove("org/a", "abc");
      expect(yield* cache.match("org/a", "abc")).toBeUndefined();
      expect(yield* cache.match("org/b", "abc")).toBeDefined();
    }).pipe(Effect.provide(EdgeCacheTest)),
  ));

test("purge removes R2 bytes then invalidates all hashes without revoking credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ArtifactStore;
      const purger = yield* ArtifactPurger;
      const coordinator = yield* CoordinatorClient;
      yield* store.put("org/a", "abc", Stream.make(new Uint8Array([65])), options);
      expect(yield* coordinator.cacheGeneration("a")).toBe(0);
      yield* purger.remove("org", "a", "abc");
      expect(yield* store.get("org/a", "abc")).toBeNull();
      expect(yield* coordinator.cacheGeneration("a")).toBe(1);
      expect(yield* coordinator.revocationEpoch("project:a")).toBe(0);
      expect(yield* coordinator.cacheGeneration("b")).toBe(0);
      yield* purger.invalidate("a");
      expect(yield* coordinator.cacheGeneration("a")).toBe(2);
    }).pipe(
      Effect.provide(
        ArtifactPurgerLive.pipe(
          Layer.provideMerge(Layer.mergeAll(ArtifactStoreTest, CoordinatorClientTest)),
        ),
      ),
    ),
  ));

test("edge cache skips objects above the non-Enterprise size ceiling without buffering their body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* EdgeCache;
      yield* cache.put(
        "o/p",
        "abc",
        new Response("x", { headers: { "content-length": "512000001" } }),
      );
      expect(yield* cache.match("o/p", "abc")).toBeUndefined();
    }).pipe(Effect.provide(EdgeCacheTest)),
  ));
