import { expect, test } from "bun:test";
import { keyPermissions } from "./cache-keys.ts";
import { githubDefaultPolicies, githubWorkflow } from "./trust-policies.ts";

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

test("API key permissions parse from Better Auth's JSON text", () => {
  expect(keyPermissions({ permissions: '{"project":["p1"],"cache":["read","write"]}' })).toEqual({
    projects: ["p1"],
    cache: ["read", "write"],
  });
  expect(keyPermissions({ permissions: "not json" })).toEqual({ projects: [], cache: [] });
});
