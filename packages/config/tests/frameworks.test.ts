import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { it } from "vitest";

const workspaceRoot = NodeURL.fileURLToPath(new NodeURL.URL("../../../", import.meta.url));
const require = NodeModule.createRequire(import.meta.url);

const oxlintBin = NodePath.join(
  NodePath.dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);

const hooks = `import { useState } from "react";
export function Widget({ enabled }) { if (enabled) useState(0); return null; }`;

const query = `import { QueryClient } from "@tanstack/react-query";
export function Widget() { const client = new QueryClient(); return client; }`;

const effect = `import * as Effect from "effect/Effect";
export const task = Effect.gen(function* () { throw new Error("failure"); });`;

const fixtures = [
  {
    project: "apps/web",
    folder: "src",
    name: "hooks.tsx",
    source: hooks,
    expected: ["react-hooks(rules-of-hooks)"],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "hooks.tsx",
    source: hooks,
    expected: ["react-hooks(rules-of-hooks)"],
  },
  {
    project: "packages/client-core",
    folder: "src",
    name: "hooks.tsx",
    source: hooks,
    expected: ["react-hooks(rules-of-hooks)"],
  },
  {
    project: "apps/web",
    folder: "src",
    name: "image.tsx",
    source: "export const Image = () => <img />;",
    expected: ["jsx-a11y(alt-text)"],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "image.tsx",
    source: "export const Image = () => <img />;",
    expected: [],
    absent: ["jsx-a11y("],
  },
  {
    project: "apps/web",
    folder: "src",
    name: "query.tsx",
    source: query,
    expected: ["tanstack-query(stable-query-client)"],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "query.tsx",
    source: query,
    expected: ["tanstack-query(stable-query-client)"],
  },
  {
    project: "apps/web",
    folder: "src",
    name: "route.ts",
    source: `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({ loader: () => null, beforeLoad: () => null });`,
    expected: ["tanstack-router(create-route-property-order)"],
  },
  {
    project: "apps/server",
    folder: "src",
    name: "effect.ts",
    source: effect,
    expected: ["effect(no-throw-in-effect-generator)"],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "effect.ts",
    source: effect,
    expected: [],
    absent: ["effect(no-throw-in-effect-generator)"],
  },
  {
    project: "apps/web",
    folder: "src",
    name: "unit.test.ts",
    source: 'import { test, expect } from "vitest"; test.only("fixture", () => expect(1).toBe(1));',
    expected: ["vitest(no-focused-tests)"],
    absent: ["jest("],
  },
  {
    project: "apps/mobile",
    folder: "__tests__",
    name: "unit-test.ts",
    source:
      'import { test, expect } from "@jest/globals"; test.only("fixture", () => expect(1).toBe(1));',
    expected: ["jest(no-focused-tests)"],
    absent: ["vitest("],
  },
  {
    project: "apps/server",
    folder: "src",
    name: "unit.test.ts",
    source:
      'import { test, expect } from "bun:test"; test.only("fixture", () => expect(1).toBe(1));',
    expected: ["eslint(no-restricted-properties)"],
    absent: ["vitest(", "jest("],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "unit.test.ts",
    source:
      'import { test, expect } from "bun:test"; test.only("fixture", () => expect(1).toBe(1));',
    expected: ["eslint(no-restricted-properties)"],
    absent: ["jest(", "vitest("],
  },
  {
    project: "apps/mobile",
    folder: "src",
    name: "promise.ts",
    source: "export const value = new Promise.resolve(1);",
    expected: ["promise(no-new-statics)"],
  },
  {
    project: "apps/web",
    folder: "e2e",
    name: "journey.spec.ts",
    source:
      'import { test } from "@playwright/test"; test("fixture", async ({ page }) => { page.goto("https://example.com"); });',
    expected: ["playwright(missing-playwright-await)"],
    absent: ["jest(", "vitest("],
  },
];

it.each(fixtures.filter(({ project }) => NodeFS.existsSync(NodePath.join(workspaceRoot, project))))(
  "scopes framework checks for $project/$name",
  ({ project, folder, name, source, expected, absent = [] }) => {
    const projectRoot = NodePath.join(workspaceRoot, project);
    const directory = NodeFS.mkdtempSync(NodePath.join(projectRoot, folder, ".lint-framework-"));

    try {
      const path = NodePath.join(directory, name);
      NodeFS.writeFileSync(path, source);

      for (const cwd of [workspaceRoot, projectRoot]) {
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [oxlintBin, "--format", "unix", path],
          { cwd, encoding: "utf8", env: { ...process.env, REPO_LINT_FIXTURE_MODE: "1" } },
        );

        const output = result.stdout + result.stderr;
        NodeAssert.equal(result.status, 0, output);

        for (const rule of expected) {
          NodeAssert.ok(output.includes(rule), `${cwd}: missing ${rule}\n${output}`);
        }

        for (const rule of absent) {
          NodeAssert.ok(!output.includes(rule), `${cwd}: unexpected ${rule}\n${output}`);
        }
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
