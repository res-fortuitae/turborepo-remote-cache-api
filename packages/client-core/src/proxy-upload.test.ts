/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun streaming/crypto boundary. */
import { expect, test } from "bun:test";
import { MULTIPART_PART_BYTES } from "@repo/api-spec";
import { Effect, Layer, Redacted } from "effect";
import { decodeJwt } from "jose";
import {
  CacheProxy,
  CacheProxyLive,
  ClientConfig,
  DpopSignerLive,
  ProxySession,
  ProxyTransport,
  TokenCache,
} from "./index.ts";

test("large streaming proxy PUT uses bounded multipart parts with fresh DPoP and retries", async () => {
  const size = 128 * 1024 * 1024 + 5;
  const proofs = new Set<string>();
  const sizes: number[] = [];
  let failures = 1;
  let completed = false;

  const transport = Layer.succeed(ProxyTransport, {
    send: (request) =>
      Effect.promise(async () => {
        expect(request.headers.get("authorization")).toBe("DPoP cache-secret");
        const proof = decodeJwt(request.headers.get("dpop")!);
        expect(proof.htm).toBe(request.method);
        expect(proof.htu).toBe(request.url);
        expect(proofs.has(proof.jti!)).toBe(false);
        proofs.add(proof.jti!);
        const path = new URL(request.url).pathname;

        if (path === "/v8/x/uploads")
          return Response.json(
            { id: "upload", partSize: MULTIPART_PART_BYTES, expiresAt: 9999999999 },
            { status: 201 },
          );

        if (path.includes("/parts/")) {
          let count = 0;

          for await (const chunk of request.body!) count += chunk.length;
          expect(count).toBe(Number(request.headers.get("content-length")));

          if (failures-- > 0) return new Response(null, { status: 503 });
          sizes.push(count);

          return Response.json({ partNumber: Number(path.split("/").at(-1)), etag: "etag" });
        }

        if (path.endsWith("/complete")) {
          completed = true;

          return Response.json({ hash: "abc" }, { status: 202 });
        }

        throw new Error("unexpected path");
      }),
  });

  const credential = {
    source: "oidc" as const,
    token: Redacted.make("cache-secret"),
    api: "https://cache.test",
    team: "org",
    project: "p",
    expiresAt: "2099-01-01T00:00:00Z",
    scope: "read write" as const,
  };
  const layer = CacheProxyLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        transport,
        DpopSignerLive,
        Layer.succeed(ProxySession, { secret: Redacted.make("session") }),
        Layer.succeed(ClientConfig, {
          api: credential.api,
          audience: credential.api,
          team: "org",
          project: "p",
          strict: true,
          boundTokens: true,
          apiKeysAllowed: true,
        }),
        Layer.succeed(TokenCache, {
          get: Effect.succeed(credential),
          peek: Effect.succeed(credential),
          clear: Effect.void,
        }),
      ),
    ),
  );
  let left = size;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) {
        controller.close();

        return;
      }

      const length = Math.min(left, 1024 * 1024);
      controller.enqueue(new Uint8Array(length));
      left -= length;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    duplex: "half",
    body,
    headers: { authorization: "Bearer session", "content-length": String(size) },
  };
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const proxy = yield* CacheProxy;

      return yield* proxy.handle(new Request("http://127.0.0.1/v8/artifacts/abc", init));
    }).pipe(Effect.provide(layer)),
  );
  expect(response.status).toBe(202);
  expect(completed).toBe(true);
  expect(sizes).toEqual([MULTIPART_PART_BYTES, MULTIPART_PART_BYTES, 5]);
  expect(proofs.size).toBe(6);
});

test("multipart stream mismatch and denied part abort the authenticated session", async () => {
  const { uploadStream } = await import("./proxy-upload.ts");
  for (const size of [3, 4]) {
    const paths: string[] = [];
    const response = await Effect.runPromise(
      uploadStream(
        new Request("http://127.0.0.1/v8/artifacts/abc", { method: "PUT", body: "abc" }),
        size,
        (path) => {
          paths.push(path);
          return Effect.succeed(
            path === "/v8/x/uploads"
              ? Response.json(
                  { id: "upload", partSize: MULTIPART_PART_BYTES, expiresAt: 9999999999 },
                  { status: 201 },
                )
              : new Response(null, { status: path.endsWith("/abort") ? 204 : 403 }),
          );
        },
      ).pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 502 })))),
    );
    expect(response.status).toBe(size === 3 ? 403 : 502);
    expect(paths.at(-1)).toBe("/v8/x/uploads/upload/abort");
    expect(paths).not.toContain("/v8/x/uploads/upload/complete");
  }
});
