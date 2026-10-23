import { expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { uniqueTeam } from "./target.ts";

const turbo = NodePath.resolve(import.meta.dir, "../../../../node_modules/.bin/turbo");

/**
 * Real `turbo` against the cache, formerly `tests/turbo-e2e.ts`: the first
 * build is a remote miss that uploads; after wiping local outputs and the
 * local cache, a read-only remote run must hit and restore the outputs.
 */
export const turboRoundTrip = async (api: string, token: string) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cache-turbo-e2e-"));
  const team = uniqueTeam("e2e");
  const expected = `remote cache round trip ${team}\n`;
  const env = { ...process.env, TURBO_API: api, TURBO_TOKEN: token, TURBO_TEAM: team };

  const run = async (command: string[]) => {
    const child = Bun.spawn(command, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // Do not print the environment: it contains the bearer token.
    expect(code, stdout + stderr).toBe(0);

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

    const output = NodePath.join(directory, "dist/artifact.txt");

    expect(await run([turbo, "run", "build", "--cache=remote:rw"])).toMatch(/cache miss/);
    expect(await Bun.file(output).text()).toBe(expected);

    await NodeFSP.rm(NodePath.join(directory, "dist"), { recursive: true });
    await NodeFSP.rm(NodePath.join(directory, ".turbo"), { recursive: true, force: true });

    expect(await run([turbo, "run", "build", "--cache=remote:r"])).toMatch(/cache hit/);
    expect(await Bun.file(output).text()).toBe(expected);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

export const testTurboRoundTrip = (target: () => { api: string; token: string }) =>
  test("real turbo misses, uploads, then hits after wiping local state", async () => {
    const { api, token } = target();
    await turboRoundTrip(api, token);
  }, 120_000);
