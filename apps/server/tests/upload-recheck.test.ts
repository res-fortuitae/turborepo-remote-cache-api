/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Exercise the real HTTP upload handler. */
import { expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { CanonicalOrigin } from "@repo/deploy-config";
import { ApiError, artifactApi } from "../src/api.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";

for (const scenario of ["transient", "concurrent", "revoked", "purge"] as const) {
  test(`post-upload ${scenario} preserves only permitted objects`, async () => {
    const bucket = memoryBucket();
    let calls = 0;
    let failures = 0;
    let cleanups = 0;
    const scope = { prefix: "team", maxUploadBytes: 100, cacheGeneration: 0 };
    const handler = artifactApi({
      recordUploadCleanup: () =>
        Effect.sync(() => {
          cleanups++;
        }),
      bucket,
      token: Redacted.make("unused"),
      edgeCacheEnabled: false,
      cache: createArtifactCache(false),
      waitUntil: () => Effect.void,
      guardAuthFailure: Effect.sync(() => {
        failures++;
      }),
      authorize: () =>
        Effect.suspend(() => {
          if (++calls === 1) return Effect.succeed(scope);
          if (scenario === "purge") return Effect.succeed({ ...scope, cacheGeneration: 1 });
          if (scenario === "concurrent")
            bucket.objects.set("team/aa", {
              size: 1,
              bytes: new Uint8Array([66]),
              customMetadata: { uploadSession: "writer-b" },
            });
          return Effect.fail(
            new ApiError({
              status: scenario === "transient" ? 500 : 401,
              code: "rejected",
              message: "recheck failed",
            }),
          );
        }),
    });
    const response = await Effect.runPromise(
      handler.pipe(
        Effect.provideService(
          Request.HttpServerRequest,
          Request.fromWeb(
            new globalThis.Request("http://localhost/v8/artifacts/aa", {
              method: "PUT",
              headers: { authorization: "Bearer test", "content-length": "1" },
              body: "A",
            }),
          ),
        ),
        Effect.provideService(CanonicalOrigin, "http://localhost"),
        Effect.map(Response.toWeb),
      ),
    );
    expect(response.status).toBe(scenario === "transient" ? 503 : scenario === "purge" ? 409 : 403);
    expect(bucket.objects.has("team/aa")).toBe(
      scenario === "transient" || scenario === "concurrent",
    );
    expect(failures).toBe(0);
    expect(cleanups).toBe(scenario === "revoked" || scenario === "purge" ? 1 : 0);
  });
}
