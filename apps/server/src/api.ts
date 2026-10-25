import type * as Cloudflare from "alchemy/Cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import { ArtifactQueryRequest, CacheEvents, type CacheEvent } from "@repo/api-spec";
import { CanonicalOrigin } from "@repo/deploy-config";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { createArtifactCache } from "./edge-cache.ts";

/**
 * Turborepo Remote Cache API (https://turborepo.dev/api/remote-cache-spec).
 *
 *   GET  /v8/artifacts/status        caching status
 *   POST /v8/artifacts               query artifact metadata
 *   POST /v8/artifacts/events        record cache usage events
 *   HEAD /v8/artifacts/:hash         artifact exists
 *   GET  /v8/artifacts/:hash         download artifact
 *   PUT  /v8/artifacts/:hash         upload artifact
 *
 * The handler is independent of the Worker runtime so unit tests can drive it
 * with an in-memory bucket; `worker.ts` supplies the R2 binding.
 */

export class ApiError extends Data.TaggedError("ApiError")<{
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

interface ArtifactResponseHeaders {
  [header: string]: string;
}

interface ArtifactQueryMetadata {
  size: number;
  taskDurationMs: number;
  tag?: string;
}

export interface StoredArtifact {
  readonly size: number;
  readonly customMetadata?: ArtifactMetadata | undefined;
}

export interface StoredArtifactBody extends StoredArtifact {
  readonly body: Stream.Stream<Uint8Array, Cloudflare.R2.R2Error>;
  readonly readable?: ReadableStream<Uint8Array> | undefined;
}

export interface ArtifactPutOptions {
  contentLength: number;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
}

/** The subset of the R2 bucket client the API uses. */
export interface ArtifactBucket<R> {
  delete?(keys: string[]): Effect.Effect<void, Cloudflare.R2.R2Error, R>;
  head(key: string): Effect.Effect<StoredArtifact | null, Cloudflare.R2.R2Error, R>;
  get(key: string): Effect.Effect<StoredArtifactBody | null, Cloudflare.R2.R2Error, R>;
  put<Err>(
    key: string,
    value: Stream.Stream<Uint8Array, Err>,
    options: ArtifactPutOptions,
  ): Effect.Effect<unknown, Cloudflare.R2.R2Error | Err, R>;
}

export interface ArtifactScope {
  readonly prefix: string;
  readonly maxUploadBytes: number;
}

export interface ApiDependencies<R> {
  readonly authorize?: (
    token: string,
    url: URL,
    action: "cache:read" | "cache:write",
  ) => Effect.Effect<ArtifactScope, ApiError, R>;
  readonly maxUploadBytes?: number;
  readonly emitEvents?: (
    team: string,
    events: readonly CacheEvent[],
  ) => Effect.Effect<void, never, R>;
  readonly bucket: ArtifactBucket<R>;
  readonly token: Redacted.Redacted<string>;
  readonly edgeCacheEnabled: boolean;
  readonly cache: ReturnType<typeof createArtifactCache>;
  readonly waitUntil: (effect: Effect.Effect<unknown, never, R>) => Effect.Effect<void, never, R>;
}

/** Constant-time string comparison to avoid leaking the token via timing. */
export const safeEqual = (a: string, b: string) => {
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
  const headers: ArtifactResponseHeaders = { "content-length": String(size) };

  if (meta.duration) headers["x-artifact-duration"] = meta.duration;

  if (meta.tag) headers["x-artifact-tag"] = meta.tag;

  if (meta.sha) headers["x-artifact-sha"] = meta.sha;

  if (meta.dirtyHash) headers["x-artifact-dirty-hash"] = meta.dirtyHash;

  return headers;
};

export const artifactApi = <R>({
  bucket,
  token,
  edgeCacheEnabled,
  cache,
  waitUntil,
  maxUploadBytes = 100_000_000,
  emitEvents = () => Effect.void,
  authorize,
}: ApiDependencies<R>) => {
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

    const url = new URL(request.url, "http://localhost");
    if (authorize && !safeEqual(value, Redacted.value(token))) {
      return yield* authorize(value, url, request.method === "PUT" ? "cache:write" : "cache:read");
    }
    if (!safeEqual(value, Redacted.value(token))) {
      return yield* new ApiError({
        status: 403,
        code: "forbidden",
        message: "Invalid token",
      });
    }
    return { prefix: yield* teamScope(url), maxUploadBytes };
  });

  const status = HttpServerResponse.json({ status: "enabled" });

  const head = Effect.fn("Api.head")(function* (key: string) {
    const object = yield* bucket.head(key);

    if (object === null) return HttpServerResponse.empty({ status: 404 });
    const meta: ArtifactMetadata = object.customMetadata ?? {};

    return HttpServerResponse.empty({
      status: 200,
      headers: artifactHeaders(object.size, meta),
    });
  });

  const download = Effect.fn("Api.download")(function* (team: string, hash: string) {
    const cached = edgeCacheEnabled ? yield* cache.match(team, hash) : undefined;

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

    const meta: ArtifactMetadata = object.customMetadata ?? {};

    const headers = {
      ...artifactHeaders(object.size, meta),
      "content-type": "application/octet-stream",
      "cache-control": cache.cacheControl,
    };

    const options = {
      status: 200,
      contentType: "application/octet-stream",
      contentLength: object.size,
      headers: { ...headers, "x-edge-cache": "MISS" },
    };

    if (!object.readable || !edgeCacheEnabled) {
      return HttpServerResponse.stream(object.body, options);
    }

    // Serve one branch to the client and store the other at the edge in the background.
    const [client, copy] = object.readable.tee();
    yield* waitUntil(cache.put(team, hash, new Response(copy, { headers })));

    return HttpServerResponse.raw(client, options);
  });

  const upload = Effect.fn("Api.upload")(function* (
    team: string,
    hash: string,
    uploadLimit: number,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const h = request.headers;
    const contentLength = Number(h["content-length"]);

    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return yield* badRequest("Missing or invalid Content-Length header");
    }

    if (contentLength > uploadLimit)
      return yield* new ApiError({
        status: 413,
        code: "payload_too_large",
        message: `Upload exceeds this instance's ${uploadLimit} byte request limit. Multipart upload support is pending STV-492.`,
      });

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

    // A deletion or archive racing an upload must not leave a newly written artifact.
    yield* authenticate.pipe(
      Effect.catch((error) =>
        (bucket.delete ? bucket.delete([`${team}/${hash}`]) : Effect.void).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );

    // Drop any stale copy cached in this datacenter.
    if (edgeCacheEnabled) yield* cache.remove(team, hash);
    const origin = yield* CanonicalOrigin;

    return yield* HttpServerResponse.json(
      { urls: [`${origin}/v8/artifacts/${hash}`] },
      { status: 202 },
    );
  });

  const query = Effect.fn("Api.query")(function* (team: string) {
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
          const meta: ArtifactMetadata = object.customMetadata ?? {};

          const metadata: ArtifactQueryMetadata = {
            size: object.size,
            taskDurationMs: Number(meta.duration ?? 0),
          };

          if (meta.tag) metadata.tag = meta.tag;

          return [hash, metadata] as const;
        }),
      { concurrency: 16 },
    );

    return yield* HttpServerResponse.json(Object.fromEntries(entries));
  });

  const events = Effect.fn("Api.events")(function* (team: string) {
    const events = yield* HttpServerRequest.schemaBodyJson(CacheEvents).pipe(
      Effect.mapError(() => badRequest("Invalid request body")),
    );

    yield* waitUntil(emitEvents(team, events));

    return HttpServerResponse.empty({ status: 200 });
  });

  return Effect.gen(function* () {
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

    const scope = yield* authenticate;
    const team = scope.prefix;
    const segment = match[1];
    const method = request.method;

    if (segment === undefined) {
      if (method === "POST") return yield* query(team);
    } else if (segment === "status") {
      if (method === "GET") return yield* status;
    } else if (segment === "events") {
      if (method === "POST") return yield* events(team);
    } else {
      if (!HASH.test(segment)) {
        return yield* badRequest("Invalid artifact hash");
      }

      if (method === "HEAD") return yield* head(`${team}/${segment}`);

      if (method === "GET") return yield* download(team, segment);

      if (method === "PUT") return yield* upload(team, segment, scope.maxUploadBytes);
    }

    return yield* new ApiError({
      status: 405,
      code: "method_not_allowed",
      message: `${method} not allowed`,
    });
  }).pipe(
    Effect.catchTags({
      R2Error: (error) =>
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
    }),
    Effect.catchTags({
      ApiError: (error) =>
        HttpServerResponse.json(
          { code: error.code, message: error.message },
          { status: error.status },
        ),
    }),
  );
};
