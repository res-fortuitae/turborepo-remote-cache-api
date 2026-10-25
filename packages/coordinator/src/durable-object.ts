import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ChainHead, type ScopeState, CoordinatorNamespace } from "./client.ts";

type Rpc<A> = Effect.Effect<A, never, RuntimeContext>;

/**
 * Strongly consistent primitives (STV-483). One instance per consistency
 * scope, addressed by name; an instance serializes its requests, so every
 * read-modify-write below is atomic. Reach it through `CoordinatorClient`.
 */
export class Coordinator extends Cloudflare.DurableObject<
  Coordinator,
  {
    /** Credentials issued before the current epoch are revoked. */
    revocationEpoch(): Rpc<number>;
    scopeState(): Rpc<ScopeState>;
    bumpCacheGeneration(): Rpc<number>;
    /** Revoke every credential issued in this scope so far. */
    bumpRevocationEpoch(): Rpc<number>;
    chainHead(): Rpc<ChainHead>;
    /** Compare-and-set: appends `hash` only if the head is still at `expectedSequence`. */
    advanceChain(expectedSequence: number, hash: string): Rpc<boolean>;
  }
>()("Coordinator") {}

const EPOCH_KEY = "revocation-epoch";
const GENERATION_KEY = "cache-generation";
const CHAIN_KEY = "chain-head";
const EMPTY_CHAIN: ChainHead = { sequence: 0, hash: null };

export const CoordinatorLive = Coordinator.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    const revocationEpoch = () =>
      Effect.map(state.storage.get<number>(EPOCH_KEY), (epoch) => epoch ?? 0);

    const chainHead = () =>
      Effect.map(state.storage.get<ChainHead>(CHAIN_KEY), (head) => head ?? EMPTY_CHAIN);

    return Effect.succeed({
      revocationEpoch,
      scopeState: () =>
        Effect.all({
          epoch: revocationEpoch(),
          generation: Effect.map(state.storage.get<number>(GENERATION_KEY), (value) => value ?? 0),
        }),
      bumpCacheGeneration: Effect.fn("Coordinator.bumpCacheGeneration")(function* () {
        const next = ((yield* state.storage.get<number>(GENERATION_KEY)) ?? 0) + 1;
        yield* state.storage.put(GENERATION_KEY, next);

        return next;
      }),
      bumpRevocationEpoch: Effect.fn("Coordinator.bumpRevocationEpoch")(function* () {
        const next = (yield* revocationEpoch()) + 1;
        yield* state.storage.put(EPOCH_KEY, next);

        return next;
      }),
      chainHead,
      advanceChain: Effect.fn("Coordinator.advanceChain")(function* (
        expectedSequence: number,
        hash: string,
      ) {
        const head = yield* chainHead();

        if (head.sequence !== expectedSequence) return false;
        yield* state.storage.put(CHAIN_KEY, { sequence: head.sequence + 1, hash });

        return true;
      }),
    });
  }),
);

/**
 * Caller-side stubs forward over RPC and never read `RuntimeContext`; the
 * requirement in the shape belongs to the object's own implementation.
 */
const fromStub = <A>(call: Rpc<A>) =>
  // SAFETY: Alchemy's RPC stub proxy ignores the context it is typed with.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- erases a phantom requirement only.
  call as unknown as Effect.Effect<A, unknown>;

/** Capture a namespace during Worker initialization; RPC stubs are request independent. */
export const makeCoordinatorNamespace = (
  namespace: Effect.Success<typeof Coordinator>,
): typeof CoordinatorNamespace.Service => ({
  getByName: (name) => {
    const stub = namespace.getByName(name);

    return {
      scopeState: () => fromStub(stub.scopeState()),
      bumpCacheGeneration: () => fromStub(stub.bumpCacheGeneration()),
      revocationEpoch: () => fromStub(stub.revocationEpoch()),
      bumpRevocationEpoch: () => fromStub(stub.bumpRevocationEpoch()),
      chainHead: () => fromStub(stub.chainHead()),
      advanceChain: (expectedSequence, hash) => fromStub(stub.advanceChain(expectedSequence, hash)),
    };
  },
});

/** Wraps the Worker's binding in CoordinatorNamespace. */
export const CoordinatorNamespaceLive = Layer.effect(
  CoordinatorNamespace,
  Effect.map(Coordinator, makeCoordinatorNamespace),
);
