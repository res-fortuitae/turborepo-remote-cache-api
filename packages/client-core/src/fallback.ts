import { Effect } from "effect";
import { ClientAuthError, ClientMessages } from "./config.ts";

/** Wrap layer construction too, so configuration failures obey the build's fail-open policy. */
export const authOrDisabled = Effect.fn("Client.authOrDisabled")(function* <A, R>(
  task: Effect.Effect<A, ClientAuthError, R>,
  strict = false,
) {
  const messages = yield* ClientMessages;

  return yield* task.pipe(
    Effect.catch((error) =>
      strict
        ? Effect.fail(error)
        : messages.warn(`Remote cache disabled: ${error.message}`).pipe(Effect.as(undefined)),
    ),
  );
});
