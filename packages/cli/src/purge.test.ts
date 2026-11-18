import { test, expect } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

test("admin purge uses the saved login origin and keeps preview, status, and confirmation separate", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tcache-purge-"));
  const requests: { path: string; method: string; body: string }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-session");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("origin")).toBe(server.url.origin);
      const path = new URL(request.url).pathname;
      requests.push({ path, method: request.method, body: await request.text() });

      if (path.endsWith("/redirect"))
        return new Response(null, { status: 307, headers: { location: "/unexpected" } });

      return Response.json({
        id: "j",
        state: "ready",
        count: 2,
        bytes: 20,
        removed: 0,
        removedBytes: 0,
      });
    },
  });

  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY
          ? [Bun.env.TCACHE_TEST_BINARY]
          : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
        "admin",
        "purge",
        "p",
        ...args,
      ],
      {
        cwd: home,
        env: {
          ...Bun.env,
          HOME: home,
          USERPROFILE: home,
          TURBO_API: "https://other-cache.example",
          TCACHE_SESSION_COOKIE: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    return { code, stdout };
  };

  try {
    const config = NodePath.join(home, ".config", "tcache");
    await NodeFSP.mkdir(config, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(config, "session.json"),
      JSON.stringify({ api: server.url.origin, token: "fixture-session" }),
      { mode: 0o600 },
    );

    const preview = await run("--filter", '{"runId":"123"}');
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).count).toBe(2);
    expect((await run("--confirm")).code).toBe(1);
    expect((await run("--job", "j")).code).toBe(0);
    expect((await run("--job", "j", "--confirm")).code).toBe(0);
    expect((await run("--job", "redirect")).code).toBe(1);
    expect(requests).toEqual([
      { path: "/projects/p/purges", method: "POST", body: '{"runId":"123"}' },
      { path: "/projects/p/purges/j", method: "GET", body: "" },
      { path: "/projects/p/purges/j/confirm", method: "POST", body: "" },
      { path: "/projects/p/purges/redirect", method: "GET", body: "" },
    ]);
  } finally {
    await server.stop(true);
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
