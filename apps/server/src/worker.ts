import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ArtifactQueryRequest, CacheEvents } from "@repo/shared";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ArtifactBucket } from "./bucket.ts";
import { residency } from "./deployment.ts";
import * as EdgeCache from "./edge-cache.ts";

/**
 * Turborepo Remote Cache API (https://turborepo.dev/api/remote-cache-spec).
 *
 *   GET  /v8/artifacts/status        caching status
 *   POST /v8/artifacts               query artifact metadata
 *   POST /v8/artifacts/events        record cache usage events
 *   HEAD /v8/artifacts/:hash         artifact exists
 *   GET  /v8/artifacts/:hash         download artifact
 *   PUT  /v8/artifacts/:hash         upload artifact
 */

class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

const badRequest = (message: string) => new ApiError({ status: 400, code: "bad_request", message });

const HASH = /^[a-fA-F0-9]+$/;
const ROUTE = /^\/v8\/artifacts(?:\/([^/]+))?\/?$/;

/** Artifact metadata persisted as R2 custom metadata. */
interface ArtifactMetadata {
  duration?: string;
  tag?: string;
  sha?: string;
  dirtyHash?: string;
}

/** Constant-time string comparison to avoid leaking the token via timing. */
const safeEqual = (a: string, b: string) => {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
};

/** Artifacts are scoped per team (`teamId` or `slug` query param). */
const teamScope = (url: URL) => {
  const team = url.searchParams.get("teamId") ?? url.searchParams.get("slug");
  if (team === null || team === "") return Effect.succeed("default");
  return /^[\w.-]+$/.test(team)
    ? Effect.succeed(team)
    : Effect.fail(badRequest("Invalid teamId or slug"));
};

const artifactHeaders = (size: number, meta: ArtifactMetadata) => {
  const headers: Record<string, string> = {
    "content-length": String(size),
  };
  if (meta.duration) headers["x-artifact-duration"] = meta.duration;
  if (meta.tag) headers["x-artifact-tag"] = meta.tag;
  if (meta.sha) headers["x-artifact-sha"] = meta.sha;
  if (meta.dirtyHash) headers["x-artifact-dirty-hash"] = meta.dirtyHash;
  return headers;
};

export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(ArtifactBucket);
    // Bound to the Worker as a secret at deploy time.
    const token = yield* Config.Redacted("TURBO_TOKEN");
    const execution = yield* Cloudflare.Workers.WorkerExecutionContext;

    const authenticate = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = request.headers["authorization"] ?? "";
      const [scheme, value] = header.split(" ", 2);
      if (scheme?.toLowerCase() !== "bearer" || !value) {
        return yield* new ApiError({
          status: 401,
          code: "unauthorized",
          message: "Missing bearer token",
        });
      }
      if (!safeEqual(value, Redacted.value(token))) {
        return yield* new ApiError({
          status: 403,
          code: "forbidden",
          message: "Invalid token",
        });
      }
    });

    const status = HttpServerResponse.json({ status: "enabled" });

    const head = (key: string) =>
      Effect.gen(function* () {
        const object = yield* bucket.head(key);
        if (object === null) return HttpServerResponse.empty({ status: 404 });
        const meta = (object.customMetadata ?? {}) as ArtifactMetadata;
        return HttpServerResponse.empty({
          status: 200,
          headers: artifactHeaders(object.size, meta),
        });
      });

    const download = (team: string, hash: string) =>
      Effect.gen(function* () {
        const cached = yield* EdgeCache.match(team, hash);
        if (cached?.body) {
          return HttpServerResponse.raw(cached.body, {
            status: 200,
            headers: { ...Object.fromEntries(cached.headers), "x-edge-cache": "HIT" },
          });
        }

        const object = yield* bucket.get(`${team}/${hash}`);
        if (object === null) {
          return yield* new ApiError({
            status: 404,
            code: "not_found",
            message: "Artifact not found",
          });
        }
        const meta = (object.customMetadata ?? {}) as ArtifactMetadata;
        const headers = {
          ...artifactHeaders(object.size, meta),
          "content-type": "application/octet-stream",
          "cache-control": EdgeCache.CACHE_CONTROL,
        };
        const options = {
          status: 200,
          contentType: "application/octet-stream",
          contentLength: object.size,
          headers: { ...headers, "x-edge-cache": "MISS" },
        };
        if (!object.readable) {
          return HttpServerResponse.stream(object.body, options);
        }
        if (!residency.allowArtifactEdgeCache) {
          return HttpServerResponse.raw(object.readable, options);
        }
        // Serve one branch to the client and store the other at the edge in the background.
        const [client, copy] = object.readable.tee();
        yield* execution.waitUntil(EdgeCache.put(team, hash, new Response(copy, { headers })));
        return HttpServerResponse.raw(client, options);
      });

    const upload = (team: string, hash: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const h = request.headers;
        const contentLength = Number(h["content-length"]);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          return yield* badRequest("Missing or invalid Content-Length header");
        }
        const duration = h["x-artifact-duration"];
        if (duration !== undefined && !/^\d+$/.test(duration)) {
          return yield* badRequest("Invalid x-artifact-duration header");
        }
        const meta: ArtifactMetadata = {};
        if (duration) meta.duration = duration;
        if (h["x-artifact-tag"]) meta.tag = h["x-artifact-tag"];
        if (h["x-artifact-sha"]) meta.sha = h["x-artifact-sha"];
        if (h["x-artifact-dirty-hash"]) meta.dirtyHash = h["x-artifact-dirty-hash"];

        yield* bucket.put(`${team}/${hash}`, request.stream, {
          contentLength,
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { ...meta },
        });
        // Drop any stale copy cached in this datacenter.
        yield* EdgeCache.remove(team, hash);
        const host = h["host"] ?? "localhost";
        const proto = h["x-forwarded-proto"] ?? (host.startsWith("localhost") ? "http" : "https");
        return yield* HttpServerResponse.json(
          { urls: [`${proto}://${host}/v8/artifacts/${hash}`] },
          { status: 202 },
        );
      });

    const query = (team: string) =>
      Effect.gen(function* () {
        const { hashes } = yield* HttpServerRequest.schemaBodyJson(ArtifactQueryRequest).pipe(
          Effect.mapError(() => badRequest("Invalid request body")),
        );
        const entries = yield* Effect.forEach(
          hashes,
          (hash) =>
            Effect.gen(function* () {
              if (!HASH.test(hash)) {
                return [hash, { error: { message: "Invalid hash" } }] as const;
              }
              const object = yield* bucket.head(`${team}/${hash}`);
              if (object === null) return [hash, null] as const;
              const meta = (object.customMetadata ?? {}) as ArtifactMetadata;
              return [
                hash,
                {
                  size: object.size,
                  taskDurationMs: Number(meta.duration ?? 0),
                  ...(meta.tag ? { tag: meta.tag } : {}),
                },
              ] as const;
            }),
          { concurrency: 16 },
        );
        return yield* HttpServerResponse.json(Object.fromEntries(entries));
      });

    const events = Effect.gen(function* () {
      const events = yield* HttpServerRequest.schemaBodyJson(CacheEvents).pipe(
        Effect.mapError(() => badRequest("Invalid request body")),
      );
      // Events are accepted and logged; persist them (e.g. Analytics Engine) if needed.
      yield* Effect.logDebug(`Recorded ${events.length} cache events`);
      return HttpServerResponse.empty({ status: 200 });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const match = ROUTE.exec(url.pathname);
        if (match === null) {
          return yield* new ApiError({
            status: 404,
            code: "not_found",
            message: "Not found",
          });
        }

        yield* authenticate;
        const team = yield* teamScope(url);
        const segment = match[1];
        const method = request.method;

        if (segment === undefined) {
          if (method === "POST") return yield* query(team);
        } else if (segment === "status") {
          if (method === "GET") return yield* status;
        } else if (segment === "events") {
          if (method === "POST") return yield* events;
        } else {
          if (!HASH.test(segment)) {
            return yield* badRequest("Invalid artifact hash");
          }
          if (method === "HEAD") return yield* head(`${team}/${segment}`);
          if (method === "GET") return yield* download(team, segment);
          if (method === "PUT") return yield* upload(team, segment);
        }

        return yield* new ApiError({
          status: 405,
          code: "method_not_allowed",
          message: `${method} not allowed`,
        });
      }).pipe(
        Effect.catchTag("R2Error", (error) =>
          Effect.logError("R2 error", error).pipe(
            Effect.andThen(
              Effect.fail(
                new ApiError({
                  status: 500,
                  code: "internal_error",
                  message: "Storage error",
                }),
              ),
            ),
          ),
        ),
        Effect.catchTag("ApiError", (error) =>
          HttpServerResponse.json(
            { code: error.code, message: error.message },
            { status: error.status },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
