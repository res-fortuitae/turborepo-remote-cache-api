/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- This Bun test suite exercises Effect 4 cache adapters without an @effect/vitest dependency. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createArtifactCache } from "../src/edge-cache.ts";
import { resolveResidency } from "../src/residency.ts";

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
    expect(await Effect.runPromise(cache.match("team one", "abc"))).toBe(response);
    await Effect.runPromise(cache.put("team two", "abc", response));
    await Effect.runPromise(cache.remove("team one", "abc"));
    expect(match).toHaveBeenCalledWith("https://artifact-cache.internal/team%20one/abc");
    expect(put).toHaveBeenCalledWith("https://artifact-cache.internal/team%20two/abc", response);
    expect(remove).toHaveBeenCalledWith("https://artifact-cache.internal/team%20one/abc");
  });
});
