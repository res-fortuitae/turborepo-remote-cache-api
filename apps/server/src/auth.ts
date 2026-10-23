import { Auth } from "@repo/auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const AUTH_PATH_PREFIX = "/api/auth/";

export const isAuthPath = (pathname: string) =>
  pathname === AUTH_PATH_PREFIX.slice(0, -1) || pathname.startsWith(AUTH_PATH_PREFIX);

const internalError = HttpServerResponse.json(
  { code: "internal_error", message: "Authentication is unavailable" },
  { status: 500 },
);

/**
 * Serves Better Auth at `/api/auth/*`. The layer is built per request,
 * because the Worker resolves its D1 and KV bindings per request.
 */
export const authRoute = <E, R>(layer: Layer.Layer<Auth, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const auth = yield* Auth;

    return HttpServerResponse.fromWeb(yield* auth.handler(web));
  }).pipe(
    Effect.provide(layer),
    // A generic layer error defeats `catchTags` inference.
    // oxlint-disable-next-line t3code/prefer-catch-tags
    Effect.catchTag("RequestParseError", () =>
      HttpServerResponse.json({ code: "bad_request", message: "Invalid request" }, { status: 400 }),
    ),
    Effect.catch((error) =>
      Effect.flatMap(Effect.logError("Auth request failed", error), () => internalError),
    ),
  );
