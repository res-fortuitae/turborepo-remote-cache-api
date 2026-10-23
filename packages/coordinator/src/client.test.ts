import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  CoordinatorClient,
  CoordinatorClientLive,
  CoordinatorClientTest,
  CoordinatorError,
  CoordinatorNamespace,
  CoordinatorNamespaceTest,
  EPOCH_CACHE_MILLIS,
} from "./client.ts";

const run = <A, E>(program: Effect.Effect<A, E, CoordinatorNamespace | TestClock.TestClock>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(
    program.pipe(Effect.provide(Layer.merge(CoordinatorNamespaceTest, TestClock.layer()))),
  );

/** Each `Effect.provide` builds a separate client, like a separate Worker isolate. */
const inIsolate = <A, E>(program: Effect.Effect<A, E, CoordinatorClient>) =>
  Effect.provide(program, CoordinatorClientLive);

describe("revocation epochs", () => {
  test("revokeAll invalidates earlier credentials immediately in the revoking isolate", async () => {
    await run(
      inIsolate(
        Effect.gen(function* () {
          const coordinator = yield* CoordinatorClient;
          const issued = yield* coordinator.revocationEpoch("org:a");
          expect(yield* coordinator.isRevoked("org:a", issued)).toBe(false);
          expect(yield* coordinator.revokeAll("org:a")).toBe(issued + 1);
          expect(yield* coordinator.isRevoked("org:a", issued)).toBe(true);
          expect(yield* coordinator.isRevoked("org:a", issued + 1)).toBe(false);
        }),
      ),
    );
  });

  test("other isolates see a bump once their cached epoch expires", async () => {
    await run(
      Effect.gen(function* () {
        const reader = yield* Layer.build(CoordinatorClientLive).pipe(
          Effect.map(Context.get(CoordinatorClient)),
        );

        expect(yield* reader.revocationEpoch("org:a")).toBe(0);
        yield* inIsolate(CoordinatorClient.use((writer) => writer.revokeAll("org:a")));
        expect(yield* reader.revocationEpoch("org:a")).toBe(0);
        yield* TestClock.adjust(EPOCH_CACHE_MILLIS);
        expect(yield* reader.revocationEpoch("org:a")).toBe(1);
      }).pipe(Effect.scoped),
    );
  });

  test("scopes are independent", async () => {
    await run(
      inIsolate(
        Effect.gen(function* () {
          const coordinator = yield* CoordinatorClient;
          yield* coordinator.revokeAll("org:a");
          expect(yield* coordinator.revocationEpoch("org:b")).toBe(0);
        }),
      ),
    );
  });

  test("transport failures become CoordinatorError", async () => {
    const failing = Layer.succeed(CoordinatorNamespace, {
      getByName: () => ({
        revocationEpoch: () => Effect.die(new Error("stub reset")),
        bumpRevocationEpoch: () => Effect.fail("unavailable"),
        chainHead: () => Effect.die(new Error("stub reset")),
        advanceChain: () => Effect.die(new Error("stub reset")),
      }),
    });

    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
    const result = await Effect.runPromise(
      CoordinatorClient.use((coordinator) => coordinator.revokeAll("org:a")).pipe(
        Effect.result,
        Effect.provide(CoordinatorClientLive.pipe(Layer.provide(failing))),
      ),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(CoordinatorError);
  });
});

describe("hash-chain sequencing", () => {
  test("advanceChain is a compare-and-set on the chain head", async () => {
    await run(
      inIsolate(
        Effect.gen(function* () {
          const coordinator = yield* CoordinatorClient;
          expect(yield* coordinator.chainHead("audit:org:a")).toEqual({ sequence: 0, hash: null });
          expect(yield* coordinator.advanceChain("audit:org:a", 0, "h1")).toBe(true);
          // A concurrent writer that read the same head loses.
          expect(yield* coordinator.advanceChain("audit:org:a", 0, "h1'")).toBe(false);
          expect(yield* coordinator.advanceChain("audit:org:a", 1, "h2")).toBe(true);
          expect(yield* coordinator.chainHead("audit:org:a")).toEqual({ sequence: 2, hash: "h2" });
          expect(yield* coordinator.chainHead("audit:org:b")).toEqual({ sequence: 0, hash: null });
        }),
      ),
    );
  });

  test("test layer state is fresh per build", async () => {
    const head = () =>
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
      Effect.runPromise(
        Effect.gen(function* () {
          const coordinator = yield* CoordinatorClient;
          yield* coordinator.advanceChain("c", 0, "h");

          return yield* coordinator.chainHead("c");
        }).pipe(Effect.provide(CoordinatorClientTest)),
      );

    expect(await head()).toEqual(await head());
  });
});
