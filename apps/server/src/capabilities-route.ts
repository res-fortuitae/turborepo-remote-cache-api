import { Auth } from "@repo/auth";
import type { CapabilityReport } from "@repo/shared";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { safeEqual } from "./api.ts";

/** Same report for signed-in console users and bearer-authenticated doctor clients. */
export const capabilitiesRoute = Effect.fn("Server.capabilities")(
  function* (report: CapabilityReport, token: Redacted.Redacted<string>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = { "cache-control": "no-store" };

    if (request.method !== "GET")
      return HttpServerResponse.empty({ status: 405, headers: { ...headers, allow: "GET" } });
    const authorization = request.headers.authorization;

    if (authorization !== undefined) {
      const [scheme, value] = authorization.split(" ", 2);

      if (scheme?.toLowerCase() !== "bearer" || !value || !safeEqual(value, Redacted.value(token)))
        return yield* HttpServerResponse.json({ code: "unauthorized" }, { status: 401, headers });
    } else {
      const auth = yield* Auth;
      const session = yield* auth.getSession(new Headers(request.headers));

      if (Option.isNone(session))
        return yield* HttpServerResponse.json({ code: "unauthorized" }, { status: 401, headers });
    }

    return yield* HttpServerResponse.json(report, { headers });
  },
  Effect.catch(() =>
    HttpServerResponse.json(
      { code: "internal_error" },
      { status: 500, headers: { "cache-control": "no-store" } },
    ),
  ),
);
