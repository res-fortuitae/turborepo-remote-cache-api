import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = new URL("./bin.ts", import.meta.url).pathname;
for (const provider of [
  "gitlab",
  "circleci",
  "buildkite",
  "bitbucket",
  "apiKey",
  "missing",
  "denied",
])
  test(`ci-auth ${provider} uses the shared exchange and safe export path`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcache-ci-"));
    let exchanges = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        exchanges++;
        expect(new URL(request.url).pathname).toBe("/oidc/exchange");
        expect(request.headers.has("dpop")).toBe(false);
        const body = await request.json();
        expect(body).toEqual({ token: "provider-assertion", team: "org", project: "project" });
        if (provider === "denied")
          return Response.json(
            { _tag: "Forbidden", code: "forbidden", message: "Exchange denied" },
            { status: 403 },
          );
        return Response.json({
          api: server.url.origin,
          team: "org",
          project: "project",
          token: "cache-credential",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          scope: "read",
        });
      },
    });
    try {
      await writeFile(
        join(directory, "buildkite-agent"),
        '#!/usr/bin/env bun\nif (Bun.argv.slice(2).join(" ") !== "oidc request-token --audience " + Bun.env.TCACHE_API) process.exit(2);\nconsole.log("provider-assertion");\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(directory, "circleci"),
        '#!/usr/bin/env bun\nconst args = Bun.argv.slice(2); if (args.slice(0,4).join(" ") !== "run oidc get --claims" || JSON.parse(args[4]!).aud !== Bun.env.TCACHE_API || args[5] !== "--v2") process.exit(2); console.log("provider-assertion");\n',
        { mode: 0o755 },
      );
      const env = {
        ...Bun.env,
        HOME: directory,
        PATH: `${directory}:${Bun.env.PATH}`,
        TCACHE_API: server.url.origin,
        TCACHE_TEAM: "org",
        TCACHE_PROJECT: "project",
        TCACHE_CI_PROVIDER: undefined,
        TCACHE_API_KEY: undefined,
        GITHUB_ACTIONS: undefined,
        VERCEL: undefined,
        GITLAB_CI: undefined,
        CACHE_ID_TOKEN: undefined,
        CIRCLECI: undefined,
        CIRCLE_OIDC_TOKEN_V2: undefined,
        BUILDKITE: undefined,
        BITBUCKET_STEP_UUID: undefined,
        BITBUCKET_STEP_OIDC_TOKEN: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
        AZURE_FEDERATED_TOKEN_FILE: undefined,
        K_SERVICE: undefined,
        GCE_METADATA_HOST: undefined,
        TCACHE_ID_TOKEN: undefined,
        TCACHE_OIDC_TOKEN_FILE: undefined,
      };
      if (provider === "gitlab" || provider === "denied")
        Object.assign(env, { GITLAB_CI: "true", CACHE_ID_TOKEN: "provider-assertion" });
      if (provider === "circleci")
        Object.assign(env, { CIRCLECI: "true", CIRCLE_OIDC_TOKEN_V2: "provider-assertion" });
      if (provider === "buildkite") Object.assign(env, { BUILDKITE: "true" });
      if (provider === "bitbucket")
        Object.assign(env, { BITBUCKET_STEP_OIDC_TOKEN: "provider-assertion" });
      if (provider === "apiKey") Object.assign(env, { TCACHE_API_KEY: "static-key" });
      const child = Bun.spawn(["bun", bin, "ci-auth", "--format", "json"], {
        cwd: directory,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).not.toContain("provider-assertion");
      expect(stderr).not.toContain("cache-credential");
      if (["missing", "denied"].includes(provider)) {
        expect(code).toBe(1);
        expect(stdout).toBe("");
      } else {
        expect(code).toBe(0);
        expect(JSON.parse(stdout).TURBO_TOKEN).toBe(
          provider === "apiKey" ? "static-key" : "cache-credential",
        );
      }
      expect(exchanges).toBe(["missing", "apiKey"].includes(provider) ? 0 : 1);
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
