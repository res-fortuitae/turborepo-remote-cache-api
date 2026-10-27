import type { ExchangeResponse } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { CiProvider } from "./ci-provider.ts";
import { ClientAuthError, ClientConfig, ClientMessages } from "./config.ts";
import { DpopSigner } from "./dpop.ts";
import { ExchangeClient } from "./exchange-client.ts";

export type ClientCredential =
  | (ExchangeResponse & { readonly source: "oidc" | "developer" })
  | (Pick<ExchangeResponse, "api" | "team" | "project" | "token"> & { readonly source: "apiKey" });

/** Device-session acquisition is implemented by CLI/device auth; no server package enters core. */
export class DeveloperCredentials extends Context.Service<
  DeveloperCredentials,
  {
    readonly acquire: Effect.Effect<ExchangeResponse, ClientAuthError>;
  }
>()("@repo/client-core/DeveloperCredentials") {}

export const DeveloperCredentialsUnavailable = Layer.succeed(DeveloperCredentials, {
  acquire: Effect.fail(
    new ClientAuthError({
      reason: "login_required",
      message:
        "No CI identity or API key is configured. Run tcache login to obtain a developer cache token.",
    }),
  ),
});

/** Refresh only near expiry. The host calls get during job setup/maintenance, peek for requests. */
export const TOKEN_REFRESH_MARGIN_MILLIS = 30_000;
export const TOKEN_RETRY_DELAY_MILLIS = 30_000;

const make = Effect.gen(function* () {
  const config = yield* ClientConfig;
  const provider = yield* CiProvider;
  const exchange = yield* ExchangeClient;
  const signer = yield* DpopSigner;
  const developer = yield* DeveloperCredentials;
  const messages = yield* ClientMessages;
  const gate = yield* Semaphore.make(1);
  let cached: ClientCredential | undefined;
  let retry: { at: number; error: ClientAuthError } | undefined;
  let refreshAt = 0;

  const expires = (credential: ClientCredential) =>
    credential.source === "apiKey" ? Infinity : Date.parse(credential.expiresAt);

  const acquire = Effect.gen(function* () {
    const detected = yield* provider.detect;

    if (detected !== undefined) {
      const token = yield* provider.token;

      const proof = config.boundTokens
        ? yield* signer.proof({ url: `${config.api}/oidc/exchange`, method: "POST" })
        : undefined;

      return { ...(yield* exchange.exchange(token, proof)), source: "oidc" as const };
    }

    if (config.apiKey !== undefined) {
      if (!config.apiKeysAllowed)
        return yield* new ClientAuthError({
          reason: "api_keys_disallowed",
          message:
            "API keys are disallowed by instance policy. Configure CI OIDC or sign in with tcache login.",
        });

      return {
        source: "apiKey" as const,
        token: config.apiKey,
        api: config.api,
        team: config.team,
        project: config.project,
      };
    }

    const result = yield* developer.acquire;

    if (
      result.api !== config.api ||
      result.team !== config.team ||
      result.project !== config.project
    )
      return yield* new ClientAuthError({
        reason: "invalid_response",
        message:
          "Developer token belongs to a different cache/project. Link the intended project and sign in again.",
      });

    return { ...result, source: "developer" as const };
  });

  const fail = (error: ClientAuthError) =>
    config.strict ? Effect.fail(error) : Effect.succeed(undefined);

  const get = gate.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (cached !== undefined && now < refreshAt) return cached;

      if (retry !== undefined && now < retry.at) return yield* fail(retry.error);

      return yield* acquire.pipe(
        Effect.flatMap((received) =>
          Effect.gen(function* () {
            let credential = received;
            const current = yield* Clock.currentTimeMillis;
            const expiry = expires(credential);

            if (!(expiry > current))
              return yield* new ClientAuthError({
                reason: "invalid_response",
                message: "Cache credential is expired. Renew the CI identity or developer session.",
              });
            // An exported environment cannot change under a running Turbo process.
            // Pin its first key, but only while the server still includes it in the active overlap.
            if (
              cached?.source !== "apiKey" &&
              cached?.signatureKey &&
              credential.source !== "apiKey" &&
              credential.signatureKey
            ) {
              const pinned = Redacted.value(cached.signatureKey);
              const keys = [credential.signatureKey, ...(credential.previousSignatureKeys ?? [])];
              if (!keys.some((key) => Redacted.value(key) === pinned))
                return yield* new ClientAuthError({
                  reason: "invalid_response",
                  message: "Artifact signing key overlap ended. Restart this cache job.",
                });
              credential = {
                ...credential,
                signatureKey: cached.signatureKey,
                previousSignatureKeys: keys.filter((key) => Redacted.value(key) !== pinned),
              };
            }
            yield* messages.mask(credential.token);

            if (credential.source !== "apiKey" && credential.signatureKey !== undefined)
              yield* messages.mask(credential.signatureKey);
            if (credential.source !== "apiKey")
              for (const key of credential.previousSignatureKeys ?? []) yield* messages.mask(key);
            cached = credential;
            // Very short tokens should still coalesce; refresh at most halfway through their life.
            refreshAt =
              expiry === Infinity
                ? Infinity
                : expiry - Math.min(TOKEN_REFRESH_MARGIN_MILLIS, (expiry - current) / 2);
            retry = undefined;

            return credential;
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            cached = undefined;
            retry = { at: (yield* Clock.currentTimeMillis) + TOKEN_RETRY_DELAY_MILLIS, error };
            // The error exposes only fixed actionable text, never a cause or raw response.
            yield* messages.warn(`Remote cache disabled: ${error.message}`);

            return yield* fail(error);
          }),
        ),
      );
    }),
  );

  return {
    get,
    /** No network, no provider read, no exchange; safe on the cache request path. */
    peek: Effect.gen(function* () {
      return cached !== undefined && expires(cached) > (yield* Clock.currentTimeMillis)
        ? cached
        : undefined;
    }),
    clear: gate.withPermits(1)(
      Effect.sync(() => {
        cached = undefined;
        retry = undefined;
        refreshAt = 0;
      }),
    ),
  };
});

export class TokenCache extends Context.Service<TokenCache, Effect.Success<typeof make>>()(
  "@repo/client-core/TokenCache",
) {}

export const TokenCacheLive = Layer.effect(TokenCache, make);
