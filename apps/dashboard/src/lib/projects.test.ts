import { expect, test } from "bun:test";
import { connectedRepositories, EVERYTHING } from "./projects.ts";

const policy = (repository: string, scope: "read" | "read write", enabled = true) => ({
  id: crypto.randomUUID(),
  projectId: "p",
  provider: "github" as const,
  enabled,
  issuer: "https://token.actions.githubusercontent.com",
  claims: { aud: ["https://c"], repository: [repository] },
  scope,
  ttlSeconds: 600,
  createdBy: "u",
  createdAt: "2026-01-01T00:00:00.000Z",
  errors: [],
  warnings: [],
});

test("groups trust policies by repository with their strongest enabled scope", () => {
  expect(
    connectedRepositories([
      policy("acme/web", "read"),
      policy("acme/web", "read write"),
      policy("acme/api", "read write", false),
    ]),
  ).toEqual([
    { name: "acme/api", provider: "github", enabled: false, policies: 1, write: false },
    { name: "acme/web", provider: "github", enabled: true, policies: 2, write: true },
  ]);
});

test("the whole-cache purge filter is non-empty and selects every upload", () => {
  expect(Object.keys(EVERYTHING)).toEqual(["since"]);
  expect(Date.parse(EVERYTHING.since)).toBe(0);
});
