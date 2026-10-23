import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { it } from "vitest";
import config from "../oxlint.ts";
import t3code from "../vendor/t3code/index.ts";
import antiSlop from "../vendor/anti-slop/index.ts";
import antiSlopEffect from "../vendor/anti-slop/effect/index.ts";

const packageRoot = NodeURL.fileURLToPath(new NodeURL.URL("../", import.meta.url));
const workspaceRoot = NodePath.resolve(packageRoot, "../..");
const require = NodeModule.createRequire(import.meta.url);

const oxlintBin = NodePath.join(
  NodePath.dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);

it("enables every upstream rule in all three plugins", () => {
  const plugins = [
    { name: "t3code", plugin: t3code, count: 29 },
    { name: "anti-slop", plugin: antiSlop, count: 18 },
    { name: "anti-slop-effect", plugin: antiSlopEffect, count: 5 },
  ];

  const enabled = new Set(Object.keys(config.rules));

  for (const { name, plugin, count } of plugins) {
    NodeAssert.equal(Object.keys(plugin.rules).length, count);
    NodeAssert.ok(config.jsPlugins.some((entry) => entry.name === name));

    for (const rule of Object.keys(plugin.rules)) {
      NodeAssert.ok(enabled.delete(`${name}/${rule}`), `Missing rule: ${name}/${rule}`);
    }
  }

  NodeAssert.deepEqual([...enabled], ["oxc/no-accumulating-spread"]);
});

it("preserves every upstream source file with only documented test-runner adaptations", () => {
  interface Snapshot {
    name: string;
    files: Record<string, string>;
  }

  // SAFETY: this checked-in JSON is generated from the upstream snapshots, not external input.
  const snapshots = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageRoot, "vendor/upstream.json"), "utf8"),
  ) as Snapshot[];

  for (const snapshot of snapshots) {
    for (const [file, expected] of Object.entries(snapshot.files)) {
      const localFile = ["package.json", "tsconfig.json"].includes(file)
        ? `${file}.upstream`
        : file;

      const bytes = NodeFS.readFileSync(
        NodePath.join(packageRoot, "vendor", snapshot.name, localFile),
      );

      if (snapshot.name === "anti-slop" && file === "rules/require-readable-spacing-cli.test.ts") {
        continue;
      }

      NodeAssert.equal(
        NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        expected,
        `${snapshot.name}/${file}`,
      );
    }

    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(packageRoot, "vendor", snapshot.name, "LICENSE")),
    );
  }
});

const consumers = [workspaceRoot];

for (const directory of ["apps", "packages", "tools"]) {
  if (!NodeFS.existsSync(NodePath.join(workspaceRoot, directory))) continue;

  for (const name of NodeFS.readdirSync(NodePath.join(workspaceRoot, directory))) {
    const path = NodePath.join(workspaceRoot, directory, name);

    if (NodeFS.existsSync(NodePath.join(path, "oxlint.config.mts"))) {
      consumers.push(path);
    }
  }
}

it.each(consumers)("loads all three plugins from consumer %s", (cwd) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "repo-config-probe-"));

  try {
    const source = NodePath.join(directory, "fixture.ts");
    NodeFS.writeFileSync(
      source,
      `
import { readFile } from "node:fs";
import { makeService } from "./service";
export const value = Reflect.get({}, "value");
export { readFile, makeService };
`,
    );

    const args = [
      oxlintBin,
      "--config",
      NodePath.join(cwd, "oxlint.config.mts"),
      "--format",
      "unix",
      source,
    ];

    const result = NodeChildProcess.spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
    const output = result.stdout + result.stderr;
    NodeAssert.equal(result.status, 0, output);

    for (const rule of [
      "namespace-node-imports",
      "no-reflect-get",
      "no-service-constructor-imports",
    ]) {
      NodeAssert.ok(output.includes(rule), output);
    }

    const strict = NodeChildProcess.spawnSync(process.execPath, [...args, "--deny-warnings"], {
      cwd,
      encoding: "utf8",
    });

    NodeAssert.equal(strict.status, 1, strict.stdout + strict.stderr);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
