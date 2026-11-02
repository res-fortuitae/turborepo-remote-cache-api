import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

const parseEnvironment = (text: string) => {
  const values: Record<string, string> = {};
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.includes("<<")) {
      const [key, delimiter] = line.split("<<");
      const value: string[] = [];

      while (++i < lines.length && lines[i] !== delimiter) value.push(lines[i]!);
      values[key!] = value.join("\n");
    } else if (line.includes("=")) {
      const at = line.indexOf("=");
      values[line.slice(0, at)] = line.slice(at + 1);
    }
  }

  return values;
};

test("runner probe uses separate steps, refreshes and verifies reverse-order post cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "probe-test-"));

  const env = {
    ...Bun.env,
    RUNNER_TEMP: directory,
    GITHUB_ENV: join(directory, "env"),
    GITHUB_STATE: join(directory, "state"),
    GITHUB_STEP_SUMMARY: join(directory, "summary"),
  };

  for (const file of [env.GITHUB_ENV, env.GITHUB_STATE, env.GITHUB_STEP_SUMMARY])
    await writeFile(file, "");

  const run = async (argv: string[], extra: Record<string, string | undefined> = {}) => {
    const child = Bun.spawn(argv, {
      cwd: root,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, code };
  };

  let exported: Record<string, string> = {};
  let state: Record<string, string> = {};

  try {
    expect((await run(["bun", "scripts/oidc-runner-probe.ts", "start"])).code).toBe(0);
    exported = parseEnvironment(await readFile(env.GITHUB_ENV, "utf8"));

    const main = await run(["node", "packages/action/dist/main.cjs"], {
      ...exported,
      INPUT_API: exported.TCACHE_PROBE_API,
      INPUT_TEAM: "org",
      INPUT_PROJECT: "p",
      INPUT_MODE: "proxy",
      INPUT_STRICT: "true",
    });

    expect(main.code, `Node Action must authenticate fixture: ${main.stderr}`).toBe(0);
    state = parseEnvironment(await readFile(env.GITHUB_STATE, "utf8"));
    exported = parseEnvironment(await readFile(env.GITHUB_ENV, "utf8"));
    const check = await run(["bun", "scripts/oidc-runner-probe.ts", "check"], exported);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toContain("Cross-step proxy");
  } finally {
    if (state.directory) {
      const post = await run(["node", "packages/action/dist/post.cjs"], {
        ...exported,
        STATE_directory: state.directory,
      });

      expect(post.code, post.stderr).toBe(0);
      expect(post.stdout).not.toContain("Unable to collect proxy stats or stop it");
    }

    const verify = await run(["node", ".github/actions/verify-proxy-cleanup/post.cjs"], exported);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stdout).toContain("closed the proxy listener");
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
