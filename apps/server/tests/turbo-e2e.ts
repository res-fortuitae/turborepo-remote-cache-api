import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const api = process.env.TURBO_API;
const token = process.env.TURBO_TOKEN;

NodeAssert.ok(api, "Set TURBO_API to the running Worker URL");

NodeAssert.ok(token, "Set TURBO_TOKEN to the Worker bearer token");

const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cache-turbo-e2e-"));
const team = `e2e-${crypto.randomUUID()}`;
const expected = `remote cache round trip ${team}\n`;
const turbo = NodePath.resolve(import.meta.dir, "../../../node_modules/.bin/turbo");
const env = { ...process.env, TURBO_API: api, TURBO_TOKEN: token, TURBO_TEAM: team };

const run = async (command: string[]) => {
  const child = Bun.spawn(command, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // Do not print the environment: it contains the bearer token.
  NodeAssert.equal(code, 0, stdout + stderr);

  return stdout + stderr;
};

try {
  await Bun.write(
    NodePath.join(directory, "package.json"),
    JSON.stringify({
      name: "cache-migration-e2e",
      private: true,
      packageManager: `bun@${Bun.version}`,
      scripts: { build: "bun build.ts" },
    }),
  );
  await Bun.write(
    NodePath.join(directory, "turbo.json"),
    JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }),
  );
  await Bun.write(
    NodePath.join(directory, "build.ts"),
    `await Bun.write("dist/artifact.txt", ${JSON.stringify(expected)});\n`,
  );
  await run([process.execPath, "install"]);

  const first = await run([turbo, "run", "build", "--cache=remote:rw", "--summarize"]);
  NodeAssert.match(first, /cache miss/);
  NodeAssert.equal(await Bun.file(NodePath.join(directory, "dist/artifact.txt")).text(), expected);

  await NodeFSP.rm(NodePath.join(directory, "dist"), { recursive: true });
  await NodeFSP.rm(NodePath.join(directory, ".turbo"), { recursive: true, force: true });

  const second = await run([turbo, "run", "build", "--cache=remote:r", "--summarize"]);
  NodeAssert.match(second, /cache hit/);
  NodeAssert.equal(await Bun.file(NodePath.join(directory, "dist/artifact.txt")).text(), expected);
  console.log("Turbo remote upload/download and output restoration passed");
} finally {
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
