import { ClientAuthError, ClientConfig, DeveloperCredentials } from "@repo/client-core";
import { ExchangeResponse } from "@repo/shared";
import { Effect, Layer, Schema } from "effect";
import { readSession } from "./device.ts";

/** CLI-only session adapter; client-core owns token coalescing and automatic refresh. */
export const developerCredentialsLive = (write = false) =>
  Layer.effect(
    DeveloperCredentials,
    Effect.gen(function* () {
      const config = yield* ClientConfig;
      return {
        acquire: Effect.tryPromise({
          try: async () => {
            const session = await readSession();
            if (!session || session.api !== config.api) throw new Error();
            const response = await fetch(`${config.api}/tokens/dev`, {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(10000),
              headers: {
                authorization: `Bearer ${session.token}`,
                origin: config.api,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                team: config.team,
                project: config.project,
                ...(write ? { write: true } : {}),
              }),
            });
            if (!response.ok) throw new Error();
            return Schema.decodeUnknownSync(ExchangeResponse)(await response.json());
          },
          catch: () =>
            new ClientAuthError({
              reason: "login_required",
              message: "Developer access unavailable. Run tcache login and check project access.",
            }),
        }),
      };
    }),
  );

export const DeveloperCredentialsLive = developerCredentialsLive();
