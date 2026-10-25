import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ChainHead {
  /** Number of entries appended so far; 0 for an empty chain. */
  readonly sequence: number;
  readonly hash: string | null;
}

export interface ScopeState {
  readonly epoch: number;
  readonly generation: number;
}

/** One Coordinator instance. Failures are transport errors from the platform. */
export interface CoordinatorInstance {
  readonly scopeState: () => Effect.Effect<ScopeState, unknown>;
  readonly bumpCacheGeneration: () => Effect.Effect<number, unknown>;
  readonly revocationEpoch: () => Effect.Effect<number, unknown>;
  readonly bumpRevocationEpoch: () => Effect.Effect<number, unknown>;
  readonly chainHead: () => Effect.Effect<ChainHead, unknown>;
  readonly advanceChain: (
    expectedSequence: number,
    hash: string,
  ) => Effect.Effect<boolean, unknown>;
}

/** The Durable Object namespace binding, wrapped by the Worker host. */
export class CoordinatorNamespace extends Context.Service<
  CoordinatorNamespace,
  { readonly getByName: (name: string) => CoordinatorInstance }
>()("@repo/coordinator/CoordinatorNamespace") {}

export class CoordinatorError extends Schema.TaggedError<CoordinatorError>()("CoordinatorError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/**
 * Revocation epochs are read on every cache request, so each isolate keeps
 * them this long. A bump made in this isolate is visible immediately; other
 * isolates see it within the TTL, well under any token lifetime.
 */
export const EPOCH_CACHE_MILLIS = 5_000;

export interface CoordinatorClientService {
  readonly cacheGeneration: (projectId: string) => Effect.Effect<number, CoordinatorError>;
  /** Call after durable deletion/replacement, before acknowledging a purge. */
  readonly invalidateCache: (projectId: string) => Effect.Effect<number, CoordinatorError>;
  /** Current epoch for a scope such as `org:<id>` or `project:<id>`. */
  readonly revocationEpoch: (scope: string) => Effect.Effect<number, CoordinatorError>;
  /** True when a credential stamped with `issuedEpoch` has been revoked. */
  readonly isRevoked: (
    scope: string,
    issuedEpoch: number,
  ) => Effect.Effect<boolean, CoordinatorError>;
  /** Emergency revocation: invalidates every credential issued in `scope` so far. */
  readonly revokeAll: (scope: string) => Effect.Effect<number, CoordinatorError>;
  readonly chainHead: (chain: string) => Effect.Effect<ChainHead, CoordinatorError>;
  /**
   * Appends `hash` after `expectedSequence`. Returns false when another
   * writer won the race; re-read the head, rehash and retry.
   */
  readonly advanceChain: (
    chain: string,
    expectedSequence: number,
    hash: string,
  ) => Effect.Effect<boolean, CoordinatorError>;
}

export class CoordinatorClient extends Context.Service<
  CoordinatorClient,
  CoordinatorClientService
>()("@repo/coordinator/CoordinatorClient") {}

const call = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.fail(new CoordinatorError({ operation, cause }))),
  );

export const CoordinatorClientLive: Layer.Layer<CoordinatorClient, never, CoordinatorNamespace> =
  Layer.effect(
    CoordinatorClient,
    Effect.gen(function* () {
      const namespace = yield* CoordinatorNamespace;
      const states = new Map<string, ScopeState & { readonly expiresAt: number }>();
      const epochInstance = (scope: string) => namespace.getByName(`epoch:${scope}`);
      const chainInstance = (chain: string) => namespace.getByName(`chain:${chain}`);

      // Never let an older in-flight read roll back a locally observed bump.
      const remember = (scope: string, state: ScopeState, expiresAt: number) => {
        const previous = states.get(scope);

        const next = {
          epoch: Math.max(previous?.epoch ?? 0, state.epoch),
          generation: Math.max(previous?.generation ?? 0, state.generation),
          expiresAt,
        };

        states.set(scope, next);

        return next;
      };

      const scopeState = Effect.fn("CoordinatorClient.scopeState")(function* (scope: string) {
        const now = yield* Clock.currentTimeMillis;
        const cached = states.get(scope);

        if (cached && cached.expiresAt > now) return cached;

        const state = yield* call(
          "CoordinatorClient.scopeState",
          epochInstance(scope).scopeState(),
        );

        return remember(scope, state, now + EPOCH_CACHE_MILLIS);
      });

      const revocationEpoch = (scope: string) =>
        Effect.map(scopeState(scope), (state) => state.epoch);

      return {
        revocationEpoch,
        cacheGeneration: (projectId) =>
          Effect.map(scopeState(`project:${projectId}`), (state) => state.generation),
        invalidateCache: Effect.fn("CoordinatorClient.invalidateCache")(function* (
          projectId: string,
        ) {
          const scope = `project:${projectId}`;

          const generation = yield* call(
            "CoordinatorClient.invalidateCache",
            epochInstance(scope).bumpCacheGeneration(),
          );

          const previous = states.get(scope);

          // Do not extend an unrelated cached epoch's freshness.
          remember(scope, { epoch: previous?.epoch ?? 0, generation }, previous?.expiresAt ?? 0);

          return generation;
        }),
        isRevoked: (scope, issuedEpoch) =>
          Effect.map(revocationEpoch(scope), (epoch) => issuedEpoch < epoch),
        revokeAll: Effect.fn("CoordinatorClient.revokeAll")(function* (scope: string) {
          const epoch = yield* call(
            "CoordinatorClient.revokeAll",
            epochInstance(scope).bumpRevocationEpoch(),
          );

          const previous = states.get(scope);

          remember(
            scope,
            { epoch, generation: previous?.generation ?? 0 },
            previous?.expiresAt ?? 0,
          );

          return epoch;
        }),
        chainHead: (chain) => call("CoordinatorClient.chainHead", chainInstance(chain).chainHead()),
        advanceChain: (chain, expectedSequence, hash) =>
          call(
            "CoordinatorClient.advanceChain",
            chainInstance(chain).advanceChain(expectedSequence, hash),
          ),
      } satisfies CoordinatorClientService;
    }),
  );

/** In-memory instances with the Durable Object's semantics, fresh per layer build. */
export const CoordinatorNamespaceTest = Layer.sync(CoordinatorNamespace, () => {
  const instances = new Map<string, CoordinatorInstance>();

  const create = (): CoordinatorInstance => {
    let epoch = 0;
    let generation = 0;
    let head: ChainHead = { sequence: 0, hash: null };

    return {
      scopeState: () => Effect.sync(() => ({ epoch, generation })),
      bumpCacheGeneration: () => Effect.sync(() => ++generation),
      revocationEpoch: () => Effect.sync(() => epoch),
      bumpRevocationEpoch: () => Effect.sync(() => ++epoch),
      chainHead: () => Effect.sync(() => head),
      advanceChain: (expectedSequence, hash) =>
        Effect.sync(() => {
          if (head.sequence !== expectedSequence) return false;
          head = { sequence: head.sequence + 1, hash };

          return true;
        }),
    };
  };

  return {
    getByName: (name) => {
      const existing = instances.get(name);

      if (existing !== undefined) return existing;
      const instance = create();
      instances.set(name, instance);

      return instance;
    },
  };
});

export const CoordinatorClientTest = CoordinatorClientLive.pipe(
  Layer.provide(CoordinatorNamespaceTest),
);
