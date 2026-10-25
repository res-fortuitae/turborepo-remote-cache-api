import { ExchangeResponse } from "@repo/api-spec";
import { OidcExchange } from "@repo/oidc";
import { Effect, Layer, Schema, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const encode = Schema.encodeEffect(ExchangeResponse);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
/** Token-authenticated CI endpoint. It never uses browser sessions or cookies. */
export const oidcApi = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST")
    return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
  const exchange = yield* OidcExchange;
  // Bound bytes while reading, even with missing/lying Content-Length or chunked bodies.
  const decoder = new TextDecoder();
  let size = 0;
  const input = yield* Stream.runFoldEffect(
    request.stream,
    () => "",
    (text, chunk) => {
      size += chunk.byteLength;
      return size > 24_576
        ? Effect.fail("oversized")
        : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
    },
  ).pipe(
    Effect.flatMap((text) => decodeJson(text + decoder.decode())),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const response = yield* exchange.exchange(input, {
    ip: request.headers["cf-connecting-ip"] ?? "",
    userAgent: request.headers["user-agent"] ?? "",
    requestId: crypto.randomUUID(),
    dpop: request.headers.dpop,
  });
  return yield* HttpServerResponse.json(yield* encode(response));
}).pipe(
  Effect.catchTag("ExchangeError", (error) =>
    HttpServerResponse.json(
      {
        _tag:
          error.status === 429
            ? "RateLimited"
            : error.status === 503
              ? "ServiceUnavailable"
              : "Forbidden",
        code:
          error.status === 429
            ? "rate_limited"
            : error.status === 503
              ? "unavailable"
              : "forbidden",
        message:
          error.status === 429
            ? "Exchange rate limit exceeded"
            : error.status === 503
              ? "Exchange unavailable"
              : "Exchange denied",
      },
      { status: error.status, headers: error.status === 429 ? { "retry-after": "60" } : {} },
    ),
  ),
  Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

export const oidcRoute = <E, R>(layer: Layer.Layer<OidcExchange, E, R>) =>
  oidcApi.pipe(
    Effect.provide(layer),
    Effect.catch(() =>
      HttpServerResponse.json(
        { _tag: "ServiceUnavailable", code: "unavailable", message: "Exchange unavailable" },
        {
          status: 503,
          headers: { "cache-control": "no-store" },
        },
      ),
    ),
  );
