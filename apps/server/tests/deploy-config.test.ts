import { afterEach, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import example from "../../../deploy.config.example.ts";
import { defineDeployConfig, workerDomain } from "../src/deploy-config.ts";
import { resolveDeployment, validateGitHubOAuth } from "../src/deployment.ts";
import { loadDeployConfig } from "../scripts/config.ts";
import { writeDeployConfig } from "../scripts/setup.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

test("the shipped config preserves retention and cache defaults", () => {
  expect(example.limits.artifactRetentionDays).toBe(30);
  expect(example.features.edgeCache).toBe(true);
  expect(example.jurisdiction).toBe("default");
});

test("GitHub OAuth requires paired public configuration and a nonempty secret", () => {
  const configured = { githubApp: { appId: 123, clientId: "Iv1.example", slug: "cache" } };
  expect(() => validateGitHubOAuth({}, false)).not.toThrow();
  expect(() => validateGitHubOAuth(configured, true)).not.toThrow();
  expect(() => validateGitHubOAuth(configured, false)).toThrow("GITHUB_OAUTH_CLIENT_SECRET");
  expect(() => validateGitHubOAuth({}, true)).toThrow("githubApp");
});

test("deployment validation rejects invalid infrastructure settings", () => {
  expect(() => defineDeployConfig({ ...example, oidcAudiences: [] })).toThrow();
  expect(() => defineDeployConfig({ ...example, oidcAudiences: [""] })).toThrow();
  expect(() =>
    defineDeployConfig({ ...example, domain: "https://cache.example.com/path" }),
  ).toThrow();
  expect(() => defineDeployConfig({ ...example, limits: { artifactRetentionDays: -1 } })).toThrow();
  expect(() =>
    defineDeployConfig({ ...example, limits: { artifactRetentionDays: 0.5 } }),
  ).toThrow();
  expect(() =>
    defineDeployConfig({ ...example, limits: { artifactRetentionDays: 30, cpuMs: 0 } }),
  ).toThrow();
  expect(() =>
    defineDeployConfig({ ...example, stages: { production: "same", staging: "same" } }),
  ).toThrow();
  expect(() =>
    defineDeployConfig({
      ...example,
      domain: "cache.example.com",
      stagingDomain: "cache.example.com",
    }),
  ).toThrow();
});

test("staging and development never attach the production domain", () => {
  const config = defineDeployConfig({
    ...example,
    domain: "cache.example.com",
    stagingDomain: "staging.example.com",
  });

  expect(workerDomain(config, "production")).toBe("cache.example.com");
  expect(workerDomain(config, "staging")).toBe("staging.example.com");
  expect(workerDomain(config, "live_developer")).toBeUndefined();
});

test("organization cache settings cannot override jurisdiction restrictions", () => {
  const eu = resolveDeployment(defineDeployConfig({ ...example, jurisdiction: "eu" }));
  const fedramp = resolveDeployment(defineDeployConfig({ ...example, jurisdiction: "fedramp" }));

  expect(eu.residency.storage.jurisdiction).toBe("eu");
  expect(eu.edgeCacheEnabled).toBe(false);
  expect(fedramp.residency.storage.jurisdiction).toBe("fedramp");
  expect(fedramp.edgeCacheEnabled).toBe(false);
  expect(resolveDeployment(example).edgeCacheEnabled).toBe(true);
  expect(resolveDeployment({ ...example, features: { edgeCache: false } }).edgeCacheEnabled).toBe(
    false,
  );
});

test("setup writes loadable config and never overwrites organization changes", async () => {
  // Keep the fixture beneath the workspace so its package import resolves.
  const root = new URL("../../../", import.meta.url);
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeURL.fileURLToPath(root), ".setup-test-"));
  directories.push(path);
  // Global URL: node:url's type differs from it once @types/node is in scope.
  const url = new URL(NodeURL.pathToFileURL(NodePath.join(path, "deploy.config.ts")).href);

  const config = defineDeployConfig({
    ...example,
    jurisdiction: "eu",
    features: { edgeCache: false },
  });

  await writeDeployConfig(url, config);
  expect(await loadDeployConfig(url)).toEqual(config);
  const bytes = await Bun.file(url).text();
  await expect(writeDeployConfig(url, example)).rejects.toThrow("EEXIST");
  expect(await Bun.file(url).text()).toBe(bytes);
});

test("missing config fails with setup instructions", async () => {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy-config-test-"));
  directories.push(path);
  await expect(
    loadDeployConfig(new URL(NodeURL.pathToFileURL(NodePath.join(path, "missing.ts")).href)),
  ).rejects.toThrow("bun run setup");
});
