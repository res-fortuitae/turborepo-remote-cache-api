import { Auth } from "@repo/auth";
import type { CapabilityReport } from "@repo/shared";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { safeEqual } from "./api.ts";
import { capabilitiesGuard, guardErrorResponse } from "./request-guards.ts";

/** Same report for signed-in console users and bearer-authenticated doctor clients. */
export const capabilitiesRoute = Effect.fn("Server.capabilities")(function* <E, R>(
  report: CapabilityReport,
  legacyToken: Redacted.Redacted<string> | undefined,
  authLayer: Layer.Layer<Auth, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headers = { "cache-control": "no-store" };

  if (request.method !== "GET")
    return HttpServerResponse.empty({ status: 405, headers: { ...headers, allow: "GET" } });
  const allowed = yield* Effect.result(capabilitiesGuard);

  if (allowed._tag === "Failure") return yield* guardErrorResponse(allowed.failure);

  const authorization = request.headers.authorization;

  if (authorization !== undefined) {
    const value = /^Bearer ([^\s,]+)$/i.exec(authorization)?.[1];

    if (legacyToken === undefined || !value || !safeEqual(value, Redacted.value(legacyToken)))
      return yield* HttpServerResponse.json({ code: "unauthorized" }, { status: 401, headers });
  } else {
    const session = yield* Auth.use((auth) => auth.getSession(new Headers(request.headers))).pipe(
      Effect.provide(authLayer),
    );

    if (Option.isNone(session))
      return yield* HttpServerResponse.json({ code: "unauthorized" }, { status: 401, headers });
  }

  return yield* HttpServerResponse.json(report, { headers });
});
