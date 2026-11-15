/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- This Bun test suite exercises Effect 4 cache adapters without an @effect/vitest dependency. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createArtifactCache } from "../src/edge-cache.ts";
import { resolveResidency } from "../src/residency.ts";

import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CanonicalOrigin } from "@repo/deploy-config";
import { artifactApi } from "../src/api.ts";
import { memoryBucket } from "./support/in-process.ts";

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

describe("artifact cache residency", () => {
  test.each(["eu", "fedramp"] as const)(
    "%s never reads or writes the worldwide cache",
    async (jurisdiction) => {
      const open = mock(() => {
        throw new Error("Cache must not be accessed");
      });

      Object.defineProperty(globalThis, "caches", { configurable: true, value: { open } });
      const cache = createArtifactCache(resolveResidency({ jurisdiction }).allowArtifactEdgeCache);

      expect(cache.cacheControl).toBe("no-store");
      expect(await Effect.runPromise(cache.match("team", "abc"))).toBeUndefined();
      await Effect.runPromise(cache.put("team", "abc", new Response("artifact")));
      await Effect.runPromise(cache.remove("team", "abc"));
      expect(open).not.toHaveBeenCalled();
    },
  );

  test("automatic placement retains the cache and scopes keys by team", async () => {
    const response = new Response("cached");
    const match = mock(async (_key: string) => response);
    const put = mock(async (_key: string, _response: Response) => {});
    const remove = mock(async (_key: string) => true);
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { open: async () => ({ match, put, delete: remove }) },
    });
    const cache = createArtifactCache(resolveResidency({}).allowArtifactEdgeCache);
    expect(cache.cacheControl).toBe("public, max-age=3600");
    expect(await Effect.runPromise(cache.match("team one", "abc"))).toBe(response);
    await Effect.runPromise(cache.put("team two", "abc", response));
    await Effect.runPromise(cache.remove("team one", "abc"));
    expect(match).toHaveBeenCalledWith("https://artifact-cache.internal/pteam%20one/g0/abc");
    expect(put).toHaveBeenCalledWith(
      "https://artifact-cache.internal/pteam%20two/g0/abc",
      response,
    );
    expect(remove).toHaveBeenCalledWith("https://artifact-cache.internal/pteam%20one/g0/abc");
  });
});

test("cold and warm artifact responses forbid downstream reuse while internal edge copies remain cacheable", async () => {
  const objects = new Map<string, { bytes: ArrayBuffer; headers: Record<string, string> }>();
  let lookups = 0;
  const bucket = memoryBucket();
  const get = bucket.get;
  let reads = 0;
  bucket.get = (key) =>
    get(key).pipe(
      Effect.map((object) => {
        reads++;
        if (object?.readable)
          object.readable.tee = () => {
            throw new Error("Download must not tee the client body");
          };
        return object;
      }),
    );
  const handler = artifactApi({
    legacyTokenEnabled: true,
    token: Redacted.make("test-token"),
    bucket,
    edgeCacheEnabled: true,
    cache: {
      cacheControl: "public, max-age=3600",
      match: (team, hash) =>
        Effect.sync(() => {
          lookups++;
          const entry = objects.get(`${team}/${hash}`);
          return entry ? new Response(entry.bytes.slice(0), { headers: entry.headers }) : undefined;
        }),
      put: (team, hash, response) =>
        Effect.promise(async () => {
          objects.set(`${team}/${hash}`, {
            bytes: await response.arrayBuffer(),
            headers: Object.fromEntries(response.headers),
          });
        }),
      remove: (team, hash) =>
        Effect.sync(() => {
          objects.delete(`${team}/${hash}`);
        }),
    },
    waitUntil: (effect) => effect,
  });
  const request = (method: string, auth = true, team = "one") =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`https://cache.test/v8/artifacts/abc?teamId=${team}`, {
            method,
            headers: {
              ...(auth ? { authorization: "Bearer test-token" } : {}),
              "content-length": "1",
            },
            ...(method === "PUT" ? { body: "x" } : {}),
          }),
        ),
      ),
      Effect.provideService(CanonicalOrigin, "https://cache.test"),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );
  expect((await request("PUT")).status).toBe(202);
  const cold = await request("GET");
  expect(cold.headers.get("x-edge-cache")).toBe("MISS");
  expect(cold.headers.get("cache-control")).toBe("no-store");
  expect(objects.get("one/abc")?.headers["cache-control"]).toBe("public, max-age=3600");
  const warm = await request("GET");
  expect(warm.headers.get("x-edge-cache")).toBe("HIT");
  expect(warm.headers.get("cache-control")).toBe("no-store");
  expect(await warm.text()).toBe("x");
  expect((await request("GET", false)).status).toBe(401);
  expect(lookups).toBe(2);
  expect(reads).toBe(2);
  expect((await request("GET", true, "two")).status).toBe(404);
});

test("dot-only legacy teams retain distinct keys after URL normalization", async () => {
  const keys: string[] = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async (key: string) => {
          keys.push(new URL(key).href);
          return undefined;
        },
      }),
    },
  });
  const cache = createArtifactCache(true);
  for (const team of [".", "..", "org/project", "org%2Fproject"])
    await Effect.runPromise(cache.match(team, "abc"));
  expect(new Set(keys).size).toBe(4);
});

test("edge cache bypasses objects over the cap and accepts the boundary", async () => {
  const { MAX_EDGE_ARTIFACT_BYTES } = await import("@repo/api-spec");
  const put = mock(async (_key: string, _response: Response) => {});
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { open: async () => ({ put }) },
  });
  const cache = createArtifactCache(true);
  let cancelled = false;
  await Effect.runPromise(
    cache.put(
      "team",
      "abc",
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(MAX_EDGE_ARTIFACT_BYTES + 1) } },
      ),
    ),
  );
  expect(cancelled).toBe(true);
  expect(put).not.toHaveBeenCalled();
  await Effect.runPromise(
    cache.put(
      "team",
      "abc",
      new Response("small fixture", {
        headers: { "content-length": String(MAX_EDGE_ARTIFACT_BYTES) },
      }),
    ),
  );
  expect(put).toHaveBeenCalledTimes(1);
});

test("a retention generation bump makes a warmed download miss and return 404", async () => {
  const bucket = memoryBucket();
  let generation = 0;
  const entries = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async (key: string) => {
          const entry = entries.get(key);
          return entry ? new Response(entry.bytes.slice(0), { headers: entry.headers }) : undefined;
        },
        put: async (key: string, response: Response) => {
          entries.set(key, { bytes: await response.arrayBuffer(), headers: response.headers });
        },
        delete: async (key: string) => entries.delete(key),
      }),
    },
  });
  const handler = artifactApi({
    token: Redacted.make("local-test"),
    bucket,
    edgeCacheEnabled: true,
    cache: createArtifactCache(true),
    authorize: () =>
      Effect.succeed({ prefix: "org/project", maxUploadBytes: 100, cacheGeneration: generation }),
    waitUntil: (effect) => effect,
  });
  const request = (method: string) =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("https://cache.test/v8/artifacts/abc", {
            method,
            headers: { authorization: "Bearer local-test", "content-length": "1" },
            ...(method === "PUT" ? { body: "x" } : {}),
          }),
        ),
      ),
      Effect.provideService(CanonicalOrigin, "https://cache.test"),
      Effect.map(HttpServerResponse.toWeb),
      Effect.runPromise,
    );
  expect((await request("PUT")).status).toBe(202);
  expect(await (await request("GET")).text()).toBe("x");
  const warm = await request("GET");
  expect(warm.headers.get("x-edge-cache")).toBe("HIT");
  await warm.text();
  await Effect.runPromise(bucket.delete(["org/project/abc"]));
  // Reproduce the old sweeper behavior: origin deletion alone leaves a cached 200.
  expect((await request("GET")).status).toBe(200);
  generation++;
  expect((await request("GET")).status).toBe(404);
});
