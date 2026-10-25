/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Real Turbo, HTTP and disk-backed R2 adapter boundary. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadArtifact } from "@repo/client-core";
import {
  MultipartBucket,
  MultipartSecret,
  MultipartUploadsLive,
  type ArtifactMetadata,
} from "@repo/artifacts";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Layer, Redacted, Stream } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { ApiError, artifactApi, type ArtifactBucket } from "../src/api.ts";
import { multipartRoute } from "../src/multipart-route.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { turboRoundTrip } from "./support/turbo.ts";

const directory = await mkdtemp(join(tmpdir(), "large-cache-test-"));
const token = "large-upload-test";
const objects = new Map<string, { path: string; size: number; customMetadata: ArtifactMetadata }>();
const sessions = new Map<
  string,
  { key: string; metadata: Record<string, string>; parts: Map<number, string> }
>();
const partSizes: number[] = [];
let created = 0;
const bucket: ArtifactBucket = {
  head: (key) => Effect.sync(() => objects.get(key) ?? null),
  get: (key) =>
    Effect.sync(() => {
      const object = objects.get(key);
      return object
        ? {
            ...object,
            body: Stream.fromReadableStream({
              evaluate: () => Bun.file(object.path).stream(),
              onError: (e) => e,
            }),
            readable: Bun.file(object.path).stream(),
          }
        : null;
    }),
  delete: (keys) =>
    Effect.promise(async () => {
      for (const key of keys) {
        const object = objects.get(key);
        if (object) await rm(object.path, { force: true });
        objects.delete(key);
      }
    }),
  put: (key, body, options) =>
    Effect.tryPromise(async () => {
      const path = join(directory, crypto.randomUUID());
      const size = await Bun.write(path, new globalThis.Response(Stream.toReadableStream(body)));
      objects.set(key, { path, size, customMetadata: options.customMetadata });
    }),
};
const multipartLayer = MultipartUploadsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(MultipartSecret, Redacted.make("large-test-upload-handle-secret")),
      Layer.succeed(MultipartBucket, {
        create: (key, metadata) =>
          Effect.sync(() => {
            const id = crypto.randomUUID();
            sessions.set(id, { key, metadata, parts: new Map() });
            created++;
            return id;
          }),
        part: (ticket, number, body, expected) =>
          Effect.tryPromise(async () => {
            const path = join(directory, `${ticket.uploadId}-${number}`);
            const size = await Bun.write(
              path,
              new globalThis.Response(Stream.toReadableStream(body)),
            );
            if (size !== expected) throw new Error("Part length mismatch");
            sessions.get(ticket.uploadId)!.parts.set(number, path);
            partSizes.push(size);
            return { partNumber: number, etag: `etag-${number}` };
          }),
        complete: (ticket, parts) =>
          Effect.tryPromise(async () => {
            const session = sessions.get(ticket.uploadId)!;
            const path = join(directory, crypto.randomUUID());
            const writer = Bun.file(path).writer();
            for (const part of parts) {
              for await (const chunk of Bun.file(session.parts.get(part.partNumber)!).stream()) {
                writer.write(chunk);
                await writer.flush();
              }
            }
            await writer.end();
            objects.set(session.key, {
              path,
              size: Bun.file(path).size,
              customMetadata: session.metadata,
            });
            for (const part of session.parts.values()) await rm(part, { force: true });
            sessions.delete(ticket.uploadId);
          }),
        abort: (ticket) =>
          Effect.promise(async () => {
            const session = sessions.get(ticket.uploadId);
            if (session) for (const path of session.parts.values()) await rm(path, { force: true });
            sessions.delete(ticket.uploadId);
          }),
        head: (key) =>
          Effect.sync(() => {
            const o = objects.get(key);
            return o ? { size: o.size, session: o.customMetadata.uploadSession } : null;
          }),
        remove: (key) => bucket.delete([key]),
      }),
    ),
  ),
);
const api = artifactApi({
  bucket,
  token: Redacted.make("unused"),
  edgeCacheEnabled: false,
  cache: createArtifactCache(false),
  waitUntil: () => Effect.void,
  authorize: (value) =>
    value !== token
      ? Effect.fail(
          new ApiError({ status: 401, code: "unauthorized", message: "Invalid credential" }),
        )
      : Effect.succeed({
          prefix: "o/p",
          cacheGeneration: 0,
          maxUploadBytes: 2_000_000_000,
          credential: {
            orgId: "o",
            projectId: "p",
            scopes: ["read", "write"],
            credentialType: "cacheJwt",
            credentialId: "jti",
            subject: "ci",
            principal: {
              org: "o",
              project: "p",
              subject: "ci",
              scope: "read write",
              tokenId: "jti",
              issuedAt: 0,
              expiresAt: Number.MAX_SAFE_INTEGER,
            },
          },
        }),
  multipart: (scope, recheck) =>
    multipartRoute(
      scope,
      recheck,
      () => Effect.void,
      () => Effect.void,
    ).pipe(
      Effect.provide(multipartLayer),
      Effect.mapError((e) =>
        e instanceof ApiError
          ? e
          : new ApiError({ status: 503, code: "storage", message: "Upload unavailable" }),
      ),
    ),
});
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 100_000_000,
  idleTimeout: 120,
  fetch: (request) =>
    Effect.runPromise(
      api.pipe(
        Effect.provideService(Request.HttpServerRequest, Request.fromWeb(request)),
        Effect.provideService(CanonicalOrigin, "http://localhost"),
        Effect.map(Response.toWeb),
      ),
    ),
});
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 2_000_000_000,
  idleTimeout: 120,
  fetch: async (request) => {
    const url = new URL(request.url);
    const upload = /^\/v8\/artifacts\/([a-fA-F0-9]+)$/.exec(url.pathname);
    if (request.method === "PUT" && upload?.[1]) {
      const path = join(directory, `proxy-${crypto.randomUUID()}`);
      try {
        await Bun.write(path, request);
        await uploadArtifact({
          server: backend.url.origin,
          token: () => token,
          hash: upload[1],
          artifact: Bun.file(path),
          headers: Object.fromEntries(request.headers),
        });
        return globalThis.Response.json({}, { status: 202 });
      } finally {
        await rm(path, { force: true });
      }
    }
    return fetch(new URL(url.pathname + url.search, backend.url), {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      ...(request.body ? { body: request.body } : {}),
    });
  },
});
afterAll(async () => {
  proxy.stop(true);
  backend.stop(true);
  await rm(directory, { recursive: true, force: true });
});

for (const bytes of [50_000_000, 150_000_000, 1_000_000_000])
  test(`real Turbo uploads and restores ${bytes} bytes through the proxy transport`, async () => {
    const previous = created;
    await turboRoundTrip(proxy.url.origin, token, undefined, bytes);
    expect(created - previous).toBe(bytes < 64 * 1024 * 1024 ? 0 : 1);
    expect(partSizes.every((size) => size <= 64 * 1024 * 1024)).toBe(true);
  }, 180_000);
