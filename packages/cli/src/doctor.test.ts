import { expect, test } from "bun:test";
import { diagnosticClaims, localWarnings } from "./doctor.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthReport, SelfTestReport } from "@repo/shared";

test("doctor checks public health by default and uses the saved session for opt-in requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-doctor-"));
  const requests: [string, string, string | null][] = [];
  const claims = { sub: "repo:org/repo" };
  const health: typeof HealthReport.Type = {
    version: "test",
    schema_version: 1,
    healthy: true,
    checks: { d1: "ok", r2: "ok", kv: "ok", coordinator: "ok" },
    capabilities: {
      analytics: false,
      auditHistory: false,
      directUploads: false,
      emailSending: false,
    },
  };
  const selftest: typeof SelfTestReport.Type = {
    ok: true,
    requestId: "fixture",
    auth: { github: false, orgCreation: "admin" },
    steps: [],
  };
  const policyPath = "/projects/project/trust-policies/test";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push([request.method, path, request.headers.get("authorization")]);
      if (path === "/healthz") return Response.json(health);
      if (path === "/api/instance/selftest") return Response.json(selftest);
      if (path === policyPath) {
        expect(await request.json()).toEqual({ claims });
        return Response.json({ matched: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  const execute = async (...args: string[]) => {
    const bin = new URL("./bin.ts", import.meta.url).pathname;
    const cli = Bun.env.TCACHE_TEST_BINARY ? [Bun.env.TCACHE_TEST_BINARY] : [process.execPath, bin];
    const child = Bun.spawn([...cli, "doctor", server.url.origin, ...args], {
      cwd: directory,
      env: {
        HOME: directory,
        PATH: Bun.env.PATH,
        TCACHE_TEAM: "org",
        TCACHE_PROJECT: "project",
        CACHE_ID_TOKEN: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
        TURBO_TOKEN: "unused-cache-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain("private-session");
    expect(stdout + stderr).not.toContain("unused-cache-token");
    return stdout;
  };
  try {
    await mkdir(join(directory, ".config/tcache"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, ".config/tcache/session.json"),
      JSON.stringify({ api: server.url.origin, token: "private-session" }),
      { mode: 0o600 },
    );

    const healthRequest: (typeof requests)[number] = ["GET", "/healthz", null];
    const policyRequest: (typeof requests)[number] = ["POST", policyPath, "Bearer private-session"];
    expect(await execute()).toContain(
      "Use --policy to request an authorized project policy dry run.",
    );
    expect(requests.splice(0)).toEqual([healthRequest]);

    expect(JSON.parse(await execute("--server", "--json"))).toMatchObject({ health, selftest });
    expect(requests.splice(0)).toEqual([
      healthRequest,
      ["POST", "/api/instance/selftest", "Bearer private-session"],
    ]);

    expect(await execute("--policy")).toContain('Policy dry run: {"matched":true}');
    expect(requests.splice(0)).toEqual([healthRequest, policyRequest]);

    expect(JSON.parse(await execute("--server", "--policy", "--json"))).toMatchObject({
      selftest,
      policy: { matched: true },
    });
    expect(requests.splice(0)).toEqual([
      healthRequest,
      ["POST", "/api/instance/selftest", "Bearer private-session"],
      policyRequest,
    ]);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor emits selected unverified claims and fixed runner warnings without secrets", () => {
  const token =
    "header." +
    Buffer.from(
      JSON.stringify({
        iss: "https://issuer.test",
        sub: "repo:org/repo",
        aud: "https://cache.test",
        exp: 1,
        nbf: Date.now() / 1000 + 120,
        access_token: "hidden",
        secret: "hidden",
        signature: "hidden",
      }),
    ).toString("base64url") +
    ".secret-signature";
  const claims = diagnosticClaims(token);
  expect(claims?.sub).toBe("repo:org/repo");
  expect(JSON.stringify(claims)).not.toContain("hidden");
  expect(JSON.stringify(claims)).not.toContain("secret-signature");
  const warnings = localWarnings(
    {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request_target",
      RUNNER_ENVIRONMENT: "self-hosted",
    },
    claims,
  );
  expect(warnings.some((w) => w.includes("id-token: write"))).toBe(true);
  expect(warnings.some((w) => w.includes("pull_request_target"))).toBe(true);
  expect(warnings.some((w) => w.includes("ephemeral"))).toBe(true);
  expect(warnings.some((w) => w.includes("expired"))).toBe(true);
  expect(warnings.some((w) => w.includes("clock"))).toBe(true);
  expect(diagnosticClaims("invalid")).toBeUndefined();
});
