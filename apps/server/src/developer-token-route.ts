import { ExchangeResponse } from "@repo/shared";
import { DeveloperTokens } from "@repo/credentials";
import { Effect, Layer, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readManagementJson } from "./projects-route.ts";

export const developerTokenApi = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST")
    return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
  const tokens = yield* DeveloperTokens;
  const result = yield* tokens.issue(
    yield* readManagementJson(request),
    new Headers(request.headers),
  );
  return yield* HttpServerResponse.json(yield* Schema.encodeEffect(ExchangeResponse)(result));
}).pipe(
  Effect.catchTag("DeveloperTokenError", (error) =>
    HttpServerResponse.json(
      { code: error.code },
      { status: error.status, headers: error.status === 429 ? { "retry-after": "60" } : {} },
    ),
  ),
  Effect.catchTag("BadRequest", () =>
    HttpServerResponse.json({ code: "bad_request" }, { status: 400 }),
  ),
  Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);
export const developerTokenRoute = <E, R>(layer: Layer.Layer<DeveloperTokens, E, R>) =>
  developerTokenApi.pipe(
    Effect.provide(layer),
    Effect.catch(() =>
      HttpServerResponse.json(
        { code: "unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      ),
    ),
  );
