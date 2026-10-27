import { Auth, requirePasskeyProof } from "@repo/auth";
import { AuditLog } from "@repo/audit";
import { Database, InstanceSettingsRepo } from "@repo/db";
import { AuthConfig, CanonicalOrigin } from "@repo/deploy-config";
import { RateLimiter } from "@repo/ratelimit";
import { Effect, Redacted } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi, ApiError, safeEqual, type ArtifactBucket } from "./api.ts";
import * as EdgeCache from "./edge-cache.ts";

/** Synthetic __selftest namespace has no project row, analytics emitter or quota hooks. */
export const selftestRoute = <R>(bucket: ArtifactBucket<R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = yield* CanonicalOrigin;
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    if (request.headers.origin !== origin) return HttpServerResponse.empty({ status: 403 });
    const limiter = yield* RateLimiter;
    const rate = yield* limiter
      .check(request.headers["cf-connecting-ip"] ?? "unknown", {
        name: "selftest",
        limit: 10,
        period: 60,
      })
      .pipe(Effect.result);
    if (rate._tag === "Failure")
      return HttpServerResponse.empty({
        status: rate.failure._tag === "RateLimited" ? 429 : 503,
        headers: { "retry-after": "60", "cache-control": "no-store" },
      });
    const authenticated = yield* (yield* Auth)
      .requireFreshSession(new Headers(request.headers))
      .pipe(Effect.result);
    if (authenticated._tag === "Failure")
      return HttpServerResponse.empty({
        status: authenticated.failure._tag === "Unauthenticated" ? 401 : 503,
      });
    const session = authenticated.success;
    if (session.session.impersonatedBy || !["owner", "admin"].includes(session.user.role ?? ""))
      return HttpServerResponse.empty({ status: 403 });
    const policy = yield* (yield* InstanceSettingsRepo).policy("");
    // Honor mandatory step-up. Do not create a weaker admin bypass for diagnostics.
    if (policy.requirePasskeyForAdmins) {
      const database = yield* Database;
      const proof = yield* Effect.tryPromise(() =>
        requirePasskeyProof(database.drizzle, session.session.id, session.user.id),
      ).pipe(Effect.result);
      if (proof._tag === "Failure") return HttpServerResponse.empty({ status: 403 });
    }
    const config = yield* AuthConfig;
    const audit = yield* AuditLog;
    const requestId = crypto.randomUUID();
    yield* audit.commit(
      {
        scope: "instance",
        actor: { type: "instanceAdmin", id: session.user.id, display: session.user.name },
        action: "instance.selftest",
        target: { type: "project", id: "__selftest" },
        outcome: "allow",
        ip: request.headers["cf-connecting-ip"] ?? "",
        userAgent: request.headers["user-agent"] ?? "",
        requestId,
        metadata: {},
      },
      () => [],
    );
    const prefix = `__selftest/${requestId}`;
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const deadline = Date.now() + 60000;
    const handler = artifactApi({
      bucket,
      token: Redacted.make(secret),
      edgeCacheEnabled: false,
      cache: EdgeCache.createArtifactCache(false),
      waitUntil: () => Effect.void,
      authorize: (token) =>
        safeEqual(token, secret) && Date.now() < deadline
          ? Effect.succeed({ prefix, maxUploadBytes: 1024 })
          : Effect.fail(
              new ApiError({
                status: 401,
                code: "unauthorized",
                message: "Invalid self-test credential",
              }),
            ),
    });
    const steps: Array<{ name: string; ok: boolean; latencyMs: number }> = [];
    const hash = "abcdef0123456789";
    const key = `${prefix}/${hash}`;
    const call = (name: string, method: string, path: string, expected: number, body?: string) =>
      Effect.gen(function* () {
        const start = Date.now();
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}${path}`, {
                method,
                headers: {
                  authorization: `Bearer ${secret}`,
                  "content-type": "application/json",
                  ...(method === "PUT"
                    ? { "content-length": String(body?.length ?? 0), "x-artifact-duration": "1" }
                    : {}),
                },
                ...(body === undefined ? {} : { body }),
              }),
            ),
          ),
        );
        const web = HttpServerResponse.toWeb(response);
        let ok = response.status === expected;
        if (name === "GET") ok = ok && (yield* Effect.promise(() => web.text())) === "selftest";
        else yield* Effect.promise(() => web.arrayBuffer());
        steps.push({ name, ok, latencyMs: Date.now() - start });
      });
    yield* Effect.gen(function* () {
      yield* call("PUT", "PUT", `/v8/artifacts/${hash}`, 202, "selftest");
      yield* call("HEAD", "HEAD", `/v8/artifacts/${hash}`, 200);
      yield* call("GET", "GET", `/v8/artifacts/${hash}`, 200);
      yield* call("query", "POST", "/v8/artifacts", 200, JSON.stringify({ hashes: [hash] }));
      yield* call("events", "POST", "/v8/artifacts/events", 200, "[]");
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const start = Date.now();
          const deleted = yield* bucket.delete([key]).pipe(Effect.result);
          steps.push({
            name: "delete",
            ok: deleted._tag === "Success",
            latencyMs: Date.now() - start,
          });
        }),
      ),
    );
    return yield* HttpServerResponse.json(
      {
        ok: steps.every((step) => step.ok),
        requestId,
        auth: { github: config.github !== undefined, orgCreation: policy.orgCreation },
        steps,
      },
      {
        status: steps.every((step) => step.ok) ? 200 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  });
