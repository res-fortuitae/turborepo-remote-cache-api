import { OidcApi, type ExchangeRequest } from "@repo/api-spec";
import { Clock, Context, Effect, Layer, Predicate, Redacted } from "effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ClientAuthError, ClientConfig } from "./config.ts";
import { boundedClient, invalidResponse } from "./http.ts";

const api = HttpApi.make("CacheAuthClient").add(OidcApi);

const make = Effect.gen(function* () {
  const config = yield* ClientConfig;
  const http = yield* HttpClient.HttpClient;

  const client = yield* HttpApiClient.makeWith(api, {
    baseUrl: config.api,
    httpClient: boundedClient(http),
  });

  return {
    exchange: Effect.fn("ExchangeClient.exchange")(function* (
      token: Redacted.Redacted<string>,
      dpop?: Redacted.Redacted<string>,
    ) {
      const payload: ExchangeRequest = { token, team: config.team, project: config.project };

      const result = yield* client.oidc.exchange({ payload, headers: { dpop } }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
        }),
        Effect.timeout("10 seconds"),
        Effect.mapError((error) => {
          if (Predicate.isTagged(error, "Forbidden"))
            return new ClientAuthError({
              reason: "policy_denied",
              message:
                "Cache policy denied this identity. Ask an admin to test the trust policy; fork/pull-request jobs may be restricted.",
            });

          if (Predicate.isTagged(error, "RateLimited"))
            return new ClientAuthError({
              reason: "rate_limited",
              message: "Cache exchange is rate limited. Wait before retrying.",
            });

          if (Predicate.isTagged(error, "SchemaError") || error instanceof ClientAuthError)
            return invalidResponse();

          return new ClientAuthError({
            reason: "unreachable",
            message:
              "Cache exchange is unavailable. Check TCACHE_API, network access and server health.",
          });
        }),
      );

      // Never accept redirection of a credential to another cache or tenant.
      if (
        result.api !== config.api ||
        result.team !== config.team ||
        result.project !== config.project ||
        Date.parse(result.expiresAt) <= (yield* Clock.currentTimeMillis)
      )
        return yield* invalidResponse();

      return result;
    }),
  };
});

export class ExchangeClient extends Context.Service<ExchangeClient, Effect.Success<typeof make>>()(
  "@repo/client-core/ExchangeClient",
) {}

export const ExchangeClientLive = Layer.effect(ExchangeClient, make);
