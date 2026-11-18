import { afterEach, expect, test } from "bun:test";
import { ensureGithubPolicies, githubDefaultPolicies, githubWorkflow } from "./trust-policies.ts";

const repo = {
  repository: "acme/web",
  repositoryId: "123",
  repositoryOwnerId: "456",
  defaultBranch: "trunk",
};

test("default GitHub policies pin immutable IDs and restrict writes to default-branch pushes", () => {
  const [write, read] = githubDefaultPolicies(repo, "https://cache.example.com");

  expect(write).toMatchObject({
    scope: "read write",
    claims: {
      aud: ["https://cache.example.com"],
      repository_id: ["123"],
      repository_owner_id: ["456"],
      ref: ["refs/heads/trunk"],
      event_name: ["push"],
    },
  });
  expect(read).toMatchObject({ scope: "read", claims: { sub: ["repo:acme/web:pull_request"] } });
  expect(read?.claims).not.toHaveProperty("event_name");
});

test("the workflow requests an OIDC token and names the org and project IDs", () => {
  const yaml = githubWorkflow({
    api: "https://c.example",
    orgId: "o1",
    projectId: "p1",
    defaultBranch: "trunk",
  });

  expect(yaml).toContain("id-token: write");
  expect(yaml).toContain("branches: [trunk]");
  expect(yaml).toContain("team: o1");
  expect(yaml).toContain("project: p1");
  expect(yaml).not.toContain("secrets.");
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resuming GitHub setup writes only the missing default policy", async () => {
  const [write, read] = githubDefaultPolicies(repo, "https://cache.example.com");
  const row = {
    id: "write",
    projectId: "p",
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    errors: [],
    warnings: [],
    ...write!,
    label: "Customized display name",
  };
  const posted: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "GET") return Response.json([row]);
    const body = JSON.parse(String(init?.body));
    posted.push(body);
    return Response.json({ ...row, ...body, id: "read" });
  }) as typeof fetch;

  await ensureGithubPolicies("p", repo, "https://cache.example.com");
  expect(posted).toEqual([read]);
});
