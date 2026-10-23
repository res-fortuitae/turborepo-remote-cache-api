import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Strongly consistent primitives (STV-483). Address one instance per
 * consistency scope, e.g. `getByName(teamId)`; instances serialize requests,
 * so read-modify-write sequences are atomic.
 */
export class Coordinator extends Cloudflare.DurableObject<
  Coordinator,
  {
    /** Credentials issued before the current epoch are revoked. */
    revocationEpoch(subject: string): Effect.Effect<number, never, RuntimeContext>;
    /** Revoke every credential issued for `subject` so far. */
    bumpRevocationEpoch(subject: string): Effect.Effect<number, never, RuntimeContext>;
  }
>()("Coordinator") {}

const epochKey = (subject: string) => `revocation-epoch:${subject}`;

export const CoordinatorLive = Coordinator.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    const revocationEpoch = (subject: string) =>
      Effect.map(state.storage.get<number>(epochKey(subject)), (epoch) => epoch ?? 0);

    return Effect.succeed({
      revocationEpoch,
      bumpRevocationEpoch: Effect.fn("Coordinator.bumpRevocationEpoch")(function* (
        subject: string,
      ) {
        const next = (yield* revocationEpoch(subject)) + 1;
        yield* state.storage.put(epochKey(subject), next);

        return next;
      }),
    });
  }),
);
