import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("inherited runner cache credentials cannot activate the live server suite", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json({ status: "enabled" });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, "test", "apps/server/tests/live.test.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...Bun.env,
        TCACHE_LIVE_TEST: undefined,
        TURBO_API: server.url.origin,
        TURBO_TOKEN: "runner-cache-fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(stdout + stderr).toContain("skip");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});
