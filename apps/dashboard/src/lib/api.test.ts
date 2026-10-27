import { afterEach, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { ApiError, api, errorMessage } from "./api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const respond = (status: number, body: unknown, seen?: { init?: RequestInit }) => {
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (seen) seen.init = init;

      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    },
    { preconnect: realFetch.preconnect },
  );
};

test("sends JSON bodies same-origin without caching", async () => {
  const seen: { init?: RequestInit } = {};
  respond(201, { id: "p1" }, seen);

  expect(await api("/orgs/o/projects", { method: "POST", body: { name: "Web" } })).toEqual({
    id: "p1",
  });
  expect(seen.init?.method).toBe("POST");
  expect(seen.init?.credentials).toBe("same-origin");
  expect(seen.init?.cache).toBe("no-store");
  expect(seen.init?.body).toBe(JSON.stringify({ name: "Web" }));
});

test("decodes responses with a shared schema", async () => {
  respond(200, { count: "nope" });

  await expect(api("/x", { schema: Schema.Struct({ count: Schema.Number }) })).rejects.toThrow();
});

test("surfaces server error codes and messages", async () => {
  respond(409, { code: "conflict", message: "Slug already in use" });
  const error = await api("/x").catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, code: "conflict", message: "Slug already in use" });
});

test("falls back to friendly messages", async () => {
  respond(403, undefined);
  const error = await api("/x").catch((cause: unknown) => cause);

  expect(errorMessage(error)).toBe("You don't have permission to do that.");
  expect(errorMessage("weird")).toContain("Something went wrong");
});
