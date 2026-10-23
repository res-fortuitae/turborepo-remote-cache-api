import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import {
  AuthKvNamespace,
  type KvStore,
  SecondaryStorage,
  SecondaryStorageError,
  SecondaryStorageLive,
} from "./secondary-storage.ts";

const fakeKv = (failing: { get?: boolean; put?: boolean; delete?: boolean } = {}) => {
  const values = new Map<string, string>();
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  const fail = () => Promise.reject(new Error("kv unavailable"));

  const kv: KvStore = {
    get: (key) => (failing.get ? fail() : Promise.resolve(values.get(key) ?? null)),
    put: (key, value, options) => {
      if (failing.put) return fail();
      puts.push({ key, ttl: options?.expirationTtl });
      values.set(key, value);

      return Promise.resolve();
    },
    delete: (key) => {
      if (failing.delete) return fail();
      values.delete(key);

      return Promise.resolve();
    },
  };

  return { kv, values, puts };
};

const run = <A, E>(program: Effect.Effect<A, E, SecondaryStorage>, kv: KvStore) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(
    Effect.provide(
      program,
      SecondaryStorageLive.pipe(Layer.provide(Layer.succeed(AuthKvNamespace, kv))),
    ),
  );

describe("SecondaryStorageLive", () => {
  test("prefixes keys and clamps TTLs to KV's 60 second minimum", async () => {
    const { kv, values, puts } = fakeKv();

    const value = await run(
      Effect.gen(function* () {
        const storage = yield* SecondaryStorage;
        yield* storage.set("token", "short", 5);
        yield* storage.set("other", "forever");

        return yield* storage.get("token");
      }),
      kv,
    );

    expect(value).toEqual(Option.some("short"));
    expect([...values.keys()]).toEqual(["auth:token", "auth:other"]);
    expect(puts).toEqual([
      { key: "auth:token", ttl: 60 },
      { key: "auth:other", ttl: undefined },
    ]);
  });

  test("read and write failures degrade to a miss", async () => {
    const { kv } = fakeKv({ get: true, put: true });

    const value = await run(
      Effect.gen(function* () {
        const storage = yield* SecondaryStorage;
        yield* storage.set("token", "value", 60);

        return yield* storage.get("token");
      }),
      kv,
    );

    expect(Option.isNone(value)).toBe(true);
  });

  test("delete failures are surfaced so revocation can't silently fail", async () => {
    const { kv } = fakeKv({ delete: true });

    const error = await run(
      Effect.flip(
        Effect.flatMap(Effect.service(SecondaryStorage), (storage) => storage.delete("t")),
      ),
      kv,
    );

    expect(error).toBeInstanceOf(SecondaryStorageError);
    expect(error.operation).toBe("delete");
  });
});
