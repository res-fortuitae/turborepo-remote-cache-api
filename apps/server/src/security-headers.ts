import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Also applied to asset responses by apps/dashboard/public/_headers. */
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

/** Preserve response bodies, cookies and status codes, including API/auth errors. */
export const withSecurityHeaders = Effect.fn("Server.withSecurityHeaders")(function* <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const response = yield* handler;
  const secured = HttpServerResponse.setHeaders(response, SECURITY_HEADERS);

  return request.originalUrl.startsWith("https://")
    ? HttpServerResponse.setHeader(secured, "strict-transport-security", "max-age=31536000")
    : secured;
});
