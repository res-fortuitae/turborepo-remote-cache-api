import { afterEach, expect, test } from "bun:test";
import { createKey, keyAttention, savePolicy, testPolicies } from "./credentials.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const policy = {
  provider: "github",
  enabled: true,
  issuer: "https://token.actions.githubusercontent.com",
  claims: { aud: ["https://cache.example"], repository_id: ["123"], repository_owner_id: ["456"] },
  scope: "read",
  ttlSeconds: 600,
};

test("policy creation uses the shared boundary contract before making a request", async () => {
  let sent: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => {
    sent = init;
    return Response.json({
      ...policy,
      id: "policy",
      projectId: "p",
      createdBy: "u",
      createdAt: "2026-01-01T00:00:00.000Z",
      errors: [],
      warnings: [],
    });
  }) as typeof fetch;
  await savePolicy("p", policy);
  expect(sent?.method).toBe("POST");
  expect(JSON.parse(String(sent?.body))).toEqual(policy);
  expect(() => savePolicy("p", { ...policy, ttlSeconds: 0 })).toThrow();
});

test("policy tester sends sample claims to simulation, never the exchange", async () => {
  let path = "";
  globalThis.fetch = (async (url) => {
    path = String(url);
    return Response.json({ simulation: true, matched: false, policyIds: [], policies: [] });
  }) as typeof fetch;
  expect((await testPolicies("p", { aud: "https://cache.example" })).simulation).toBe(true);
  expect(path).toBe("/projects/p/trust-policies/test");
});

test("API key defaults remain project-scoped, expiring and read-only", async () => {
  let body: unknown;
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ id: "k", key: "once" });
  }) as typeof fetch;
  expect((await createKey("org", "project", "CI", false, 7)).key).toBe("once");
  expect(body).toEqual({
    organizationId: "org",
    name: "CI",
    expiresIn: 604800,
    permissions: { project: ["project"], cache: ["read"] },
  });
});

test("disabled API-key policy errors remain visible to the client", async () => {
  globalThis.fetch = (async (_url: string | URL | Request) =>
    Response.json({ message: "API keys disabled" }, { status: 403 })) as typeof fetch;
  await expect(createKey("org", "p", "CI", false, 7)).rejects.toThrow("API keys disabled");
});

test("old and unused keys include never-used keys, using the creation timestamp", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  expect(keyAttention({ createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null }, now)).toEqual({
    old: true,
    unused: true,
  });
  expect(keyAttention({ createdAt: "2026-10-26T00:00:00Z", lastUsedAt: now }, now)).toEqual({
    old: false,
    unused: false,
  });
});
