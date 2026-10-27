import { afterEach, expect, test } from "bun:test";
import { elevate, instanceOrgs, leaveElevation } from "./instance.ts";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the instance organization directory follows cursors", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    paths.push(String(input));
    return Response.json(
      paths.length === 1
        ? { organizations: [{ id: "one" }], nextCursor: "one" }
        : { organizations: [{ id: "two" }], nextCursor: null },
    );
  }) as typeof fetch;
  expect((await instanceOrgs()).map((org) => org.id)).toEqual(["one", "two"]);
  expect(paths[1]).toBe("/api/auth/instance/orgs?cursor=one");
});

test("elevation requires explicit reason and duration, with a separate leave operation", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ success: true });
  }) as typeof fetch;
  await elevate("org", "Support case 42", 300);
  await leaveElevation("org");
  expect(calls).toEqual([
    {
      path: "/api/auth/instance/orgs/elevate",
      body: { orgId: "org", reason: "Support case 42", ttlSeconds: 300 },
    },
    { path: "/api/auth/instance/orgs/leave", body: { orgId: "org" } },
  ]);
});
