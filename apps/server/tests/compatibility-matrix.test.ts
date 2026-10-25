import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const version = Bun.env.TURBO_COMPAT_VERSION;
const mode = Bun.env.TURBO_COMPAT_MODE ?? "direct";
const cli = Bun.env.TCACHE_COMPAT_BIN;
let directory: string;
let turbo: string;
let api = Bun.env.TURBO_COMPAT_API;
let token = Bun.env.TURBO_COMPAT_TOKEN;
let preview: Miniflare | undefined;
const report: string[] = [];

describe.skipIf(!version)(`Turbo ${version} / ${mode} compatibility`, () => {
  beforeAll(async () => {
    if (!["direct", "proxy"].includes(mode)) throw new Error("Invalid TURBO_COMPAT_MODE");
    if (mode === "proxy" && !cli)
      throw new Error("Set TCACHE_COMPAT_BIN to the real tcache CLI entry point");
    directory = await mkdtemp(join(tmpdir(), "turbo-compat-"));
    const tools = join(directory, "tools");
    await Bun.write(
      join(tools, "package.json"),
      JSON.stringify({ private: true, dependencies: { turbo: version } }),
    );
    const install = Bun.spawn([process.execPath, "install"], {
      cwd: tools,
      stdout: "ignore",
      stderr: "pipe",
    });
    const installError = await new Response(install.stderr).text();
    expect(await install.exited, installError).toBe(0);
    // Run the package's JS launcher with Bun: avoids .cmd/symlink assumptions on Windows.
    turbo = join(tools, "node_modules/turbo/bin/turbo");
    if (Boolean(api) !== Boolean(token))
      throw new Error("Preview API and token must be supplied together");
    if (
      api &&
      (!Bun.env.TURBO_COMPAT_TEAM_ID?.startsWith("team_") ||
        !Bun.env.TURBO_COMPAT_TEAM_SLUG ||
        !Bun.env.TURBO_COMPAT_PROJECT)
    )
      throw new Error(
        "Deployed preview requires a team_-prefixed org ID, its slug, and a project; set TURBO_COMPAT_TEAM_ID/TEAM_SLUG/PROJECT",
      );
    if (!api) {
      token = `tcache_${crypto.randomUUID()}`;
      const bundle = await Bun.build({
        entrypoints: [fileURLToPath(new URL("./support/compatibility-worker.ts", import.meta.url))],
        target: "browser",
        minify: true,
        external: ["node:*"],
      });
      if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"));
      preview = new Miniflare({
        modules: true,
        script: await bundle.outputs[0]!.text(),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["BUCKET"],
        bindings: { TOKEN: token },
        host: "127.0.0.1",
        port: 0,
      });
      api = (await preview.ready).origin;
    }
    const url = new URL(api!);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      throw new Error("Preview must use HTTPS or loopback");
  }, 120_000);

  afterAll(async () => {
    await preview?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (Bun.env.TURBO_COMPAT_REPORT)
      await Bun.write(Bun.env.TURBO_COMPAT_REPORT, report.join("\n") + "\n");
  });

  // Together these exercise both selector encodings, preflight on/off, and signing on/off.
  for (const signed of [false, true])
    for (const selector of ["slug", "teamId"]) {
      test(`${selector}, signature=${signed}, preflight=${signed}: upload then remote-only restore`, async () => {
        const workspace = join(directory, crypto.randomUUID());
        const reportIndex = report.length;
        report.push(
          `| ${version} | ${process.platform} | ${mode} | ${selector} | ${signed} | ${signed} | failed/incomplete |`,
        );
        const team =
          selector === "teamId"
            ? (Bun.env.TURBO_COMPAT_TEAM_ID ?? `team_${crypto.randomUUID()}`)
            : (Bun.env.TURBO_COMPAT_TEAM_SLUG ?? `compat-${crypto.randomUUID()}`);
        const expected = `compatibility-${crypto.randomUUID()}`;
        const signatureKey = "compatibility-test-signature-key-32-bytes-minimum";
        const v1 = version!.startsWith("1.");
        await Bun.write(
          join(workspace, "package.json"),
          JSON.stringify({
            name: "turbo-compat-fixture",
            private: true,
            packageManager: `bun@${Bun.version}`,
            scripts: { build: "bun build.ts" },
          }),
        );
        await Bun.write(
          join(workspace, "turbo.json"),
          JSON.stringify({
            [v1 ? "pipeline" : "tasks"]: { build: { outputs: ["dist/**"] } },
            remoteCache: {
              signature: signed,
              ...(selector === "teamId" ? { teamId: team } : { teamSlug: team }),
            },
          }),
        );
        await Bun.write(
          join(workspace, "build.ts"),
          `await Bun.write("dist/result.txt", ${JSON.stringify(expected)});`,
        );
        const env = { ...Bun.env };
        // This suite deliberately exercises a scoped API-key fallback, never the CI runner's identity.
        for (const name of [
          "GITHUB_ACTIONS",
          "VERCEL",
          "GITLAB_CI",
          "CACHE_ID_TOKEN",
          "CIRCLECI",
          "CIRCLE_OIDC_TOKEN_V2",
          "BUILDKITE",
          "TCACHE_CI_PROVIDER",
          "TCACHE_ID_TOKEN",
          "BITBUCKET_STEP_UUID",
          "BITBUCKET_STEP_OIDC_TOKEN",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "AZURE_FEDERATED_TOKEN_FILE",
          "K_SERVICE",
          "GCE_METADATA_HOST",
          "TCACHE_OIDC_TOKEN_FILE",
          "TURBO_CACHE",
          "TURBO_TEAM",
          "TURBO_TEAMID",
          "TURBO_PREFLIGHT",
          "TURBO_REMOTE_ONLY",
          "TURBO_REMOTE_CACHE_READ_ONLY",
        ])
          delete env[name];
        Object.assign(env, {
          TURBO_API: api,
          TURBO_TOKEN: token,
          TURBO_REMOTE_CACHE_TIMEOUT: "15",
          TURBO_REMOTE_CACHE_SIGNATURE_KEY: signed ? signatureKey : undefined,
          TURBO_TELEMETRY_DISABLED: "1",
          DO_NOT_TRACK: "1",
          TCACHE_API: api,
          TCACHE_API_KEY: token,
          TCACHE_TEAM: team,
          TCACHE_PROJECT: Bun.env.TURBO_COMPAT_PROJECT ?? "compatibility",
        });
        const run = async (readOnly: boolean, override?: Record<string, string>) => {
          const args = [
            process.execPath,
            turbo,
            "run",
            "build",
            ...(v1
              ? ["--remote-only", ...(readOnly ? ["--remote-cache-read-only"] : [])]
              : [readOnly ? "--cache=remote:r" : "--cache=remote:rw"]),
            ...(signed ? ["--preflight"] : []),
          ];
          const command =
            mode === "proxy"
              ? [process.execPath, resolve(cli!), "exec", "--strict", "--", ...args]
              : args;
          const child = Bun.spawn(command, {
            cwd: workspace,
            env: { ...env, ...override },
            stdout: "pipe",
            stderr: "pipe",
          });
          const timeout = setTimeout(() => child.kill(), 60_000);
          try {
            const [out, err, code] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            // Credentials must never be present in failure output.
            const output = (out + err).replaceAll(token!, "[redacted]");
            expect(code, output).toBe(0);
            return output;
          } finally {
            clearTimeout(timeout);
            child.kill();
          }
        };
        const install = Bun.spawn([process.execPath, "install"], {
          cwd: workspace,
          env,
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(await install.exited).toBe(0);
        expect(await run(false)).toMatch(/cache miss/);
        const output = join(workspace, "dist/result.txt");
        expect(await Bun.file(output).text()).toBe(expected);
        const clear = async () => {
          await rm(join(workspace, "dist"), { recursive: true, force: true });
          await rm(join(workspace, ".turbo"), { recursive: true, force: true });
        };
        await clear();
        expect(await run(true)).toMatch(/cache hit/);
        expect(await Bun.file(output).text()).toBe(expected);
        if (signed) {
          await clear();
          // A changed key must reject the stored signature and execute the task as a miss.
          expect(
            await run(true, { TURBO_REMOTE_CACHE_SIGNATURE_KEY: signatureKey + "-wrong" }),
          ).toMatch(/cache miss/);
        }
        report[reportIndex] =
          `| ${version} | ${process.platform} | ${mode} | ${selector} | ${signed} | ${signed} | pass |`;
      }, 120_000);
    }

  test("preview OPTIONS is successful without a redirect", async () => {
    const response = await fetch(`${api}/v8/artifacts/abc`, {
      method: "OPTIONS",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(204);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
  });
});
