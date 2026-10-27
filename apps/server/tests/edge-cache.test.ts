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
    expect(match).toHaveBeenCalledWith("https://artifact-cache.internal/team%20one/g0/abc");
    expect(put).toHaveBeenCalledWith("https://artifact-cache.internal/team%20two/g0/abc", response);
    expect(remove).toHaveBeenCalledWith("https://artifact-cache.internal/team%20one/g0/abc");
  });
});

test("cold and warm artifact responses forbid downstream reuse while internal edge copies remain cacheable", async () => {
  const objects = new Map<string, { bytes: ArrayBuffer; headers: Record<string, string> }>();
  let lookups = 0;
  const handler = artifactApi({
    legacyTokenEnabled: true,
    token: Redacted.make("test-token"),
    bucket: memoryBucket(),
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
  expect((await request("GET", true, "two")).status).toBe(404);
});
