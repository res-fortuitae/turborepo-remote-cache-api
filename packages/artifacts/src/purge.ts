import { CoordinatorClient, type CoordinatorError } from "@repo/coordinator/client";
import { Context, Effect, Layer } from "effect";
import { ArtifactStore, type ArtifactStorageError } from "./store.ts";

/** Shared purge primitive for incident response and future anomaly handlers. */
export class ArtifactPurger extends Context.Service<
  ArtifactPurger,
  {
    readonly remove: (
      orgId: string,
      projectId: string,
      hash: string,
    ) => Effect.Effect<void, ArtifactStorageError | CoordinatorError>;
    /** Invoke after durable batch/project deletion, before reporting success. */
    readonly invalidate: (projectId: string) => Effect.Effect<number, CoordinatorError>;
  }
>()("@repo/artifacts/ArtifactPurger") {}

export const ArtifactPurgerLive = Layer.effect(
  ArtifactPurger,
  Effect.gen(function* () {
    const store = yield* ArtifactStore;
    const coordinator = yield* CoordinatorClient;

    return {
      remove: Effect.fn("ArtifactPurger.remove")(function* (
        orgId: string,
        projectId: string,
        hash: string,
      ) {
        yield* store.remove(`${orgId}/${projectId}`, hash);
        // A failed bump fails the purge; a retry safely repeats deletion and invalidation.
        yield* coordinator.invalidateCache(projectId);
      }),
      invalidate: coordinator.invalidateCache,
    } satisfies typeof ArtifactPurger.Service;
  }),
);
