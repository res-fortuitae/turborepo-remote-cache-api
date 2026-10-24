/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun fetch requests cross the Effect boundary in this test helper. */
import { expect, test } from "bun:test";
import { CanonicalOrigin } from "@repo/deploy-config";
import { DashboardAssets } from "@repo/infra";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi } from "../src/api.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { SECURITY_HEADERS, withSecurityHeaders } from "../src/security-headers.ts";
import { memoryBucket } from "./support/in-process.ts";

const serve = <E>(
  request: Request,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | CanonicalOrigin
  >,
) =>
  Effect.runPromise(
    withSecurityHeaders(handler).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(CanonicalOrigin, "https://cache.example.com"),
      Effect.map(HttpServerResponse.toWeb),
    ),
  );

const api = () =>
  artifactApi({
    bucket: memoryBucket(),
    token: Redacted.make("test-token"),
    edgeCacheEnabled: false,
    cache: createArtifactCache(false),
    waitUntil: () => Effect.void,
  });

test("upload URLs use the configured origin despite hostile request/proxy headers", async () => {
  const response = await serve(
    new Request("https://alternate.example.com/v8/artifacts/abc", {
      method: "PUT",
      body: "x",
      headers: {
        authorization: "Bearer test-token",
        "content-length": "1",
        host: "evil.example.com",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "http",
      },
    }),
    api(),
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ urls: ["https://cache.example.com/v8/artifacts/abc"] });
});

test("API errors carry the security baseline and no CORS grants", async () => {
  const response = await serve(new Request("https://cache.example.com/v8/artifacts/status"), api());

  expect(response.status).toBe(401);
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
});

test("auth response bodies and multiple session cookies survive the header middleware", async () => {
  const headers = new Headers({ location: "/dashboard" });
  headers.append("set-cookie", "session=one; Path=/; Secure; HttpOnly; SameSite=Lax");
  headers.append("set-cookie", "state=two; Path=/; Secure; HttpOnly; SameSite=Lax");

  const response = await serve(
    new Request("https://cache.example.com/api/auth/callback/github"),
    Effect.succeed(HttpServerResponse.fromWeb(new Response("signed in", { status: 302, headers }))),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/dashboard");
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(await response.text()).toBe("signed in");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("HTTP development responses do not advertise HSTS", async () => {
  const response = await serve(
    new Request("http://localhost:1337/api/auth/ok"),
    Effect.succeed(HttpServerResponse.text("ok")),
  );

  expect(response.headers.get("strict-transport-security")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("reserved API paths bypass dashboard assets, including SPA navigation requests", () => {
  const rules = DashboardAssets.runWorkerFirst;

  for (const path of ["/v8", "/v8/*", "/api", "/api/*", "/oidc", "/oidc/*", "/.well-known/*"]) {
    expect(rules).toContain(path);
  }

  expect(DashboardAssets.notFoundHandling).toBe("single-page-application");
});

test("dashboard assets receive the same baseline on the assets-first path", async () => {
  const rules = await Bun.file(new URL("../../dashboard/public/_headers", import.meta.url)).text();
  const headers = rules.toLowerCase();

  expect(headers.startsWith("/*\n")).toBe(true);
  expect(headers).toContain("strict-transport-security: max-age=31536000");

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers).toContain(`${name}: ${value.toLowerCase()}`);
  }
});
