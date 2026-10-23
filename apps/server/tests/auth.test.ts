import { describe, expect, test } from "bun:test";
import { Auth } from "@repo/auth";
import { AuthTest } from "@repo/auth/testing";
import { Effect, Layer } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { authRoute, isAuthPath } from "../src/auth.ts";

const serve = <E>(request: Request, layer: Layer.Layer<Auth, E>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(
    authRoute(layer).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.map(HttpServerResponse.toWeb),
    ),
  );

describe("auth route", () => {
  test("matches only /api/auth paths", () => {
    expect(isAuthPath("/api/auth")).toBe(true);
    expect(isAuthPath("/api/auth/get-session")).toBe(true);
    expect(isAuthPath("/api/authz")).toBe(false);
    expect(isAuthPath("/v8/artifacts/status")).toBe(false);
  });

  test("forwards requests to Better Auth", async () => {
    const response = await serve(new Request("http://localhost/api/auth/ok"), AuthTest);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("returns null for get-session without a cookie", async () => {
    const response = await serve(new Request("http://localhost/api/auth/get-session"), AuthTest);

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  test("answers 500 when the auth layer can't be built", async () => {
    const broken = Layer.effect(Auth, Effect.fail("no binding"));
    const response = await serve(new Request("http://localhost/api/auth/ok"), broken);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal_error",
      message: "Authentication is unavailable",
    });
  });
});
