import { afterEach, expect, test } from "bun:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { checkBoundaries } from "./package-boundaries.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boundaries-"));
  roots.push(root);

  return root;
}

function workspace(root: string, name: string, source: string, dependencies = {}) {
  const directory = NodePath.join(root, "packages", name);
  NodeFS.mkdirSync(NodePath.join(directory, "src"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "package.json"),
    JSON.stringify({ name: `@repo/${name}`, dependencies }),
  );
  NodeFS.writeFileSync(NodePath.join(directory, "src/index.ts"), source);
}

test("allows declared providers and ignores comments and string data", () => {
  const root = fixture();
  workspace(root, "db", "");
  workspace(
    root,
    "auth",
    `import type { Database } from '@repo/db';\n// import '@repo/artifacts'\nconst text = "import '@repo/artifacts'";`,
    { "@repo/db": "workspace:*" },
  );
  expect(checkBoundaries(root)).toEqual([]);
});

test("rejects reverse dependencies in manifests and catches cycles", () => {
  const root = fixture();
  workspace(root, "db", "", { "@repo/auth": "workspace:*" });
  workspace(root, "auth", "", { "@repo/db": "workspace:*" });
  expect(checkBoundaries(root).join("\n")).toContain("forbidden dependency @repo/db -> @repo/auth");
  expect(checkBoundaries(root).join("\n")).toContain("dependency cycle");
});

test("rejects type imports, re-exports, dynamic imports, require, and import-equals in the wrong direction", () => {
  const root = fixture();
  workspace(root, "auth", "");
  workspace(
    root,
    "db",
    `import type { Auth } from '@repo/auth';
export * from '@repo/auth';
type Auth = import('@repo/auth').Auth;
const load = () => import('@repo/auth');
const required = require('@repo/auth');
import auth = require('@repo/auth');`,
  );
  expect(
    checkBoundaries(root).filter((error) => error.includes("forbidden dependency")),
  ).toHaveLength(6);
});

test("rejects relative escapes, private subpaths, and undeclared providers", () => {
  const root = fixture();
  workspace(root, "db", "");
  workspace(root, "auth", `import '../../db/src/index.ts';\nimport '@repo/db/src/private';`);
  const errors = checkBoundaries(root).join("\n");
  expect(errors).toContain("relative import escapes workspace");
  expect(errors).toContain("public entry point");
  expect(errors).toContain("undeclared workspace dependency");
});

test("rejects app imports, unknown packages, aliases, and computed domain imports", () => {
  const root = fixture();
  workspace(root, "surprise", "");
  workspace(
    root,
    "auth",
    `import '@repo/server';\nimport '#private';\nconst load = (name: string) => import(name);`,
  );
  const errors = checkBoundaries(root).join("\n");
  expect(errors).toContain("explicit package boundary policy");
  expect(errors).toContain("forbidden dependency @repo/auth -> @repo/server");
  expect(errors).toContain("import aliases");
  expect(errors).toContain("computed imports");
});

test("allows config tooling but rejects runtime config dependencies", () => {
  const root = fixture();
  workspace(root, "config", "");
  workspace(root, "auth", "import '@repo/config/oxlint';", { "@repo/config": "workspace:*" });
  expect(checkBoundaries(root).join("\n")).toContain(
    "forbidden dependency @repo/auth -> @repo/config",
  );
});

test("allows app composition and development tooling without allowing app dependencies", () => {
  const root = fixture();
  workspace(root, "config", "");
  workspace(root, "db", "");
  workspace(root, "cli", "import '@repo/db';", { "@repo/db": "workspace:*" });
  const directory = NodePath.join(root, "packages/db");
  NodeFS.writeFileSync(
    NodePath.join(directory, "package.json"),
    JSON.stringify({
      name: "@repo/db",
      devDependencies: { "@repo/config": "workspace:*" },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "oxlint.config.mts"),
    "import '@repo/config/oxlint';",
  );
  expect(checkBoundaries(root)).toEqual([]);
  NodeFS.writeFileSync(NodePath.join(directory, "src/index.ts"), "export * from '@repo/cli';");
  expect(checkBoundaries(root).join("\n")).toContain("forbidden dependency @repo/db -> @repo/cli");
});

test("checks optional and peer dependencies even without source imports", () => {
  const root = fixture();
  workspace(root, "auth", "");
  workspace(root, "db", "");
  NodeFS.writeFileSync(
    NodePath.join(root, "packages/db/package.json"),
    JSON.stringify({
      name: "@repo/db",
      optionalDependencies: { "@repo/auth": "workspace:*" },
      peerDependencies: { "@repo/auth": "workspace:*" },
    }),
  );
  const errors = checkBoundaries(root).join("\n");
  expect(errors).toContain("package.json (optionalDependencies)");
  expect(errors).toContain("package.json (peerDependencies)");
});
