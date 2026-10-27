import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin = new URL("./bin.ts", import.meta.url).pathname;
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
