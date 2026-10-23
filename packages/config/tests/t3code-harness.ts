import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { it } from "vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(import.meta.url);

const oxlintBin = NodePath.join(
  NodePath.dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);

const pluginPath = NodeURL.fileURLToPath(
  new NodeURL.URL("../vendor/t3code/index.ts", import.meta.url),
);

interface RuleHarnessOptions {
  readonly filename?: string;
  readonly ruleOptions?: ReadonlyArray<unknown>;
}

export const createOxlintRuleHarness = (ruleName: string, options: RuleHarnessOptions = {}) => {
  const run = async (source: string, invalid: boolean, assertion?: (output: string) => void) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "listener-t3code-rule-"),
    );

    try {
      const configPath = NodePath.join(directory, ".oxlintrc.json");
      const sourcePath = NodePath.join(directory, options.filename ?? "fixture.ts");
      await NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true });
      await NodeFSP.writeFile(sourcePath, source);
      await NodeFSP.writeFile(
        configPath,
        JSON.stringify({
          categories: { correctness: "off" },
          jsPlugins: [{ name: "t3code", specifier: pluginPath }],
          rules: { [ruleName]: ["error", ...(options.ruleOptions ?? [])] },
        }),
      );

      let status = 0;
      let output: string;

      try {
        const result = await execFile(
          process.execPath,
          [oxlintBin, "--format", "default", "--config", configPath, sourcePath],
          {
            cwd: directory,
          },
        );

        output = result.stdout + result.stderr;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          !("stdout" in error) ||
          !("stderr" in error)
        ) {
          throw error;
        }

        NodeAssert.ok(Number.isFinite(error.code), `exit code: ${error.message}`);
        status = Number(error.code);
        output = String(error.stdout) + String(error.stderr);
      }

      NodeAssert.equal(status, invalid ? 1 : 0, output);

      if (invalid) {
        const [namespace, rule] = ruleName.split("/");
        NodeAssert.ok(
          output.includes(`${namespace}(${rule})`) || output.includes(ruleName),
          output,
        );
        assertion?.(output);
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };

  return {
    valid(name: string, source: string) {
      it(name, () => run(source, false));
    },
    invalid(name: string, source: string, assertion?: (output: string) => void) {
      it(name, () => run(source, true, assertion));
    },
  };
};
