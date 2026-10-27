import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";

const bin = new URL("./bin.ts", import.meta.url).pathname;

test("headless login explicitly stores a private session file without an OS keychain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-file-login-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      if (new URL(request.url).pathname.endsWith("/device/code"))
        return Response.json({
          device_code: "device",
          user_code: "CODE1234",
          verification_uri: `${server.url.origin}/device`,
          expires_in: 300,
          interval: 5,
        });
      return Response.json({ access_token: "private-device-session" });
    },
  });
  try {
    const child = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY ? [Bun.env.TCACHE_TEST_BINARY] : ["bun", bin]),
        "login",
        "--file-session",
        "--api",
        server.url.origin,
      ],
      {
        cwd: directory,
        env: { ...Bun.env, HOME: directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain("private-device-session");
    const path = join(directory, ".config/tcache/session.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      api: server.url.origin,
      token: "private-device-session",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, ".config/tcache"))).mode & 0o777).toBe(0o700);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("developer writes require an explicit CLI option and preserve server denials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-developer-write-"));
  const requests: unknown[] = [];
  let allowWrites = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      expect(request.headers.get("authorization")).toBe("Bearer private-session");
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          team: Schema.String,
          project: Schema.String,
          write: Schema.optional(Schema.Boolean),
        }),
      )(await request.json());
      requests.push(body);
      if (body.write && !allowWrites) return new Response(null, { status: 403 });
      return Response.json({
        api: server.url.origin,
        team: "org",
        project: "project",
        token: "private-cache-token",
        scope: body.write ? "read write" : "read",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    },
  });
  const execute = async (...flags: string[]) => {
    const child = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY ? [Bun.env.TCACHE_TEST_BINARY] : ["bun", bin]),
        "exec",
        "--strict",
        ...flags,
        "--",
        "bun",
        "-e",
        "process.exit(0)",
      ],
      {
        cwd: directory,
        env: {
          ...Bun.env,
          HOME: directory,
          TCACHE_API: server.url.origin,
          TCACHE_TEAM: "org",
          TCACHE_PROJECT: "project",
          TCACHE_API_KEY: undefined,
          TCACHE_CI_PROVIDER: undefined,
          GITHUB_ACTIONS: undefined,
          CI: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain("private-session");
    expect(stdout + stderr).not.toContain("private-cache-token");
    return code;
  };
  try {
    await mkdir(join(directory, ".config/tcache"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, ".config/tcache/session.json"),
      JSON.stringify({ api: server.url.origin, token: "private-session" }),
      { mode: 0o600 },
    );
    expect(await execute()).toBe(0);
    expect(requests[0]).toEqual({ team: "org", project: "project" });
    expect(await execute("--write")).toBe(0);
    expect(requests[1]).toEqual({ team: "org", project: "project", write: true });
    allowWrites = false;
    expect(await execute("--write")).toBe(1);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Effect CLI handles account, linking, permissions, and command exit codes without printing sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-cli-"));
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer private-session");
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/api/auth/get-session")
        return Response.json({
          user: { id: "u", name: "User", email: "u@example.com" },
          session: { token: "private-session" },
        });
      if (path === "/api/auth/organization/list")
        return Response.json([{ id: "org-id", slug: "org", name: "Org" }]);
      if (path === "/projects/project-id")
        return Response.json({ id: "project-id", orgId: "org-id", slug: "web", name: "Web" });
      return Response.json({ success: true });
    },
  });
  const execute = async (...args: string[]) => {
    const child = Bun.spawn(
      [...(Bun.env.TCACHE_TEST_BINARY ? [Bun.env.TCACHE_TEST_BINARY] : ["bun", bin]), ...args],
      {
        cwd: directory,
        env: {
          ...Bun.env,
          HOME: directory,
          TCACHE_API: undefined,
          TURBO_API: undefined,
          TCACHE_TEAM: undefined,
          TCACHE_PROJECT: undefined,
          TCACHE_API_KEY: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain("private-session");
    return { stdout, stderr, code };
  };
  try {
    await mkdir(join(directory, ".config/tcache"), { recursive: true, mode: 0o700 });
    const sessionFile = join(directory, ".config/tcache/session.json");
    await writeFile(
      sessionFile,
      JSON.stringify({ api: server.url.origin, token: "private-session" }),
      { mode: 0o600 },
    );
    expect((await execute("--help")).stdout).toContain("SUBCOMMANDS");
    const who = await execute("whoami");
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout).email).toBe("u@example.com");
    expect((await execute("link", "--team", "org", "--project", "project-id")).code).toBe(0);
    const linked = JSON.parse(await readFile(join(directory, ".turbo-cache.json"), "utf8"));
    expect(linked).toEqual({
      api: server.url.origin,
      team: "org-id",
      teamSlug: "org",
      project: "project-id",
      projectSlug: "web",
    });
    expect((await execute("link", "--team", "org", "--project", "project-id")).code).toBe(1);
    expect((await execute("exec", "--", "bun", "-e", "process.exit(7)")).code).toBe(7);
    expect((await execute("logout")).code).toBe(0);
    expect(paths).toContain("/api/auth/sign-out");
    await expect(readFile(sessionFile)).rejects.toThrow();
    await writeFile(
      sessionFile,
      JSON.stringify({ api: server.url.origin, token: "private-session" }),
      { mode: 0o600 },
    );
    await chmod(sessionFile, 0o644);
    expect((await execute("whoami")).code).toBe(1);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
