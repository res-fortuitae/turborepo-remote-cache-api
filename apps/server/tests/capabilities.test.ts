/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Exercises the HTTP adapter at the Bun/Effect boundary. */
import { expect, test } from "bun:test";
import { CanonicalOrigin } from "@repo/deploy-config";
import { DatabaseTest } from "@repo/db/testing";
import { AuthTest } from "@repo/auth/testing";
import { resolveCapabilities } from "@repo/infra";
import { CapabilityReport } from "@repo/shared";
import { AnalyticsEmitter } from "@repo/analytics";
import { Mailer } from "@repo/mailer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { capabilitiesRoute } from "../src/capabilities-route.ts";
import { Capabilities, capabilityLayers } from "../src/capabilities.ts";
import { artifactApi } from "../src/api.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";

const decodeCapabilities = Schema.decodeUnknownSync(CapabilityReport);

const report = resolveCapabilities(
  { dev: false, catalogToken: false, features: { analytics: false } },
  { workersPlan: "unknown", zonePlan: "none" },
);

const token = Redacted.make("capabilities-test-token");

const request = async (headers: Record<string, string> = {}, method = "GET") => {
  const response = await Effect.runPromise(
    capabilitiesRoute(report, token).pipe(
      Effect.provide(AuthTest),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/api/instance/capabilities", { headers, method }),
        ),
      ),
      Effect.scoped,
    ),
  );

  return HttpServerResponse.toWeb(response);
};

test("doctor receives a versioned, non-cacheable capability report", async () => {
  const response = await request({ authorization: "Bearer capabilities-test-token" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(decodeCapabilities(await response.json())).toEqual(report);
});

test("capabilities reject anonymous, invalid credentials and mutations", async () => {
  expect((await request()).status).toBe(401);
  expect((await request({ authorization: "Bearer invalid" })).status).toBe(401);
  const mutation = await request({ authorization: "Bearer capabilities-test-token" }, "POST");
  expect(mutation.status).toBe(405);
  expect(mutation.headers.get("allow")).toBe("GET");
});

test("disabled layers need no platform bindings and never pretend to deliver email", async () => {
  const layers = capabilityLayers.pipe(
    Layer.provide(Layer.succeed(Capabilities, report)),
    Layer.provide(DatabaseTest),
  );

  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* AnalyticsEmitter;
      const mailer = yield* Mailer;
      yield* emitter.emit({ orgId: "o", projectId: "p" }, []);

      return yield* Effect.result(
        mailer.send({ to: "a@example.com", subject: "invite", text: "link" }),
      );
    }).pipe(Effect.provide(layers), Effect.scoped),
  );

  expect(results._tag).toBe("Failure");
});

test("upload ceiling rejects before reading the body or touching storage", async () => {
  const bucket = memoryBucket();
  bucket.failing = true;

  const api = artifactApi({
    bucket,
    token,
    edgeCacheEnabled: false,
    cache: createArtifactCache(false),
    waitUntil: () => Effect.void,
  });

  const response = await Effect.runPromise(
    api.pipe(
      Effect.provideService(CanonicalOrigin, "http://localhost"),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/v8/artifacts/abc", {
            method: "PUT",
            headers: {
              authorization: "Bearer capabilities-test-token",
              "content-length": "100000001",
            },
          }),
        ),
      ),
    ),
  );

  expect(response.status).toBe(413);
  expect(bucket.objects.size).toBe(0);
});

test("cache event batches reach the selected emitter with the namespace", async () => {
  const batches: string[] = [];

  const api = artifactApi({
    bucket: memoryBucket(),
    token,
    edgeCacheEnabled: false,
    cache: createArtifactCache(false),
    waitUntil: (effect) => effect.pipe(Effect.asVoid),
    emitEvents: (team, events) =>
      Effect.sync(() => {
        batches.push(`${team}:${events.length}`);
      }),
  });

  const response = await Effect.runPromise(
    api.pipe(
      Effect.provideService(CanonicalOrigin, "http://localhost"),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/v8/artifacts/events?teamId=project-a", {
            method: "POST",
            headers: {
              authorization: "Bearer capabilities-test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify([{ sessionId: "s", source: "REMOTE", event: "HIT", hash: "abc" }]),
          }),
        ),
      ),
    ),
  );

  expect(response.status).toBe(200);
  expect(batches).toEqual(["project-a:1"]);
});
