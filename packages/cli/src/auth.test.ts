/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun application adapter integration. */
import { expect, test } from "bun:test";
import { formatEnvironment } from "./auth.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("env formats escape shell values and reject line injection", () => {
  expect(formatEnvironment({ TURBO_TEAM: "a'b" }, "shell")).toBe("export TURBO_TEAM='a'\\''b'");
  expect(formatEnvironment({ TURBO_TEAM: "org" }, "github")).toBe("TURBO_TEAM=org");
  expect(() => formatEnvironment({ TURBO_TEAM: "org\nINJECT=1" }, "dotenv")).toThrow();
  expect(() => formatEnvironment({ TURBO_TOKEN: "a$B" }, "gitlab")).toThrow();
  expect(JSON.parse(formatEnvironment({ TURBO_TEAM: "org" }, "json"))).toEqual({
    TURBO_TEAM: "org",
  });
});

test("exec streams upload, authenticates locally, preserves HEAD and cleans up listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-exec-"));
  let uploaded = 0;
  let upstreamToken = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      upstreamToken = request.headers.get("authorization") ?? "";

      if (request.method === "PUT") {
        expect(request.headers.get("content-length")).toBe("1048576");

        for await (const chunk of request.body!) uploaded += chunk.byteLength;

        return new Response(null, { status: 202 });
      }

      return new Response(request.method === "HEAD" ? null : "artifact", {
        headers: { "content-length": "8" },
      });
    },
  });

  try {
    const script = join(directory, "child.ts");
    await Bun.write(
      script,
      `const api = Bun.env.TURBO_API!;
      const bad = await fetch(api + '/v8/artifacts/hash');
      if (bad.status !== 401) process.exit(2);
      const headers = {authorization: 'Bearer ' + Bun.env.TURBO_TOKEN};
      const preflight = await fetch(api + '/v8/artifacts/hash', {method:'OPTIONS',headers});
      if (preflight.status !== 204 || preflight.headers.has('location') || !preflight.headers.get('access-control-allow-headers')?.includes('Authorization')) process.exit(3);
      const unauthenticatedPreflight = await fetch(api + '/v8/artifacts/hash', {method:'OPTIONS'});
      if (unauthenticatedPreflight.status !== 401) process.exit(4);
      const put = await fetch(api + '/v8/artifacts/hash', {method:'PUT',headers:{...headers,'content-length':'1048576'},body:new Uint8Array(1048576)});
      const head = await fetch(api + '/v8/artifacts/hash', {method:'HEAD',headers});
      console.log(JSON.stringify({api,put:put.status,head:head.status,length:head.headers.get('content-length'),token:Bun.env.TURBO_TOKEN}));`,
    );

    const child = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY
          ? [Bun.env.TCACHE_TEST_BINARY]
          : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
        "exec",
        "--",
        "bun",
        script,
      ],
      {
        env: {
          ...Bun.env,
          TCACHE_API: server.url.origin,
          TCACHE_TEAM: "org",
          TCACHE_PROJECT: "project",
          TCACHE_API_KEY: "actual-key",
          TCACHE_CI_PROVIDER: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.put).toBe(202);
    expect(report.head).toBe(200);
    expect(report.length).toBe("8");
    expect(report.token).not.toBe("actual-key");
    expect(upstreamToken).toBe("Bearer actual-key");
    expect(uploaded).toBe(1048576);
    expect(stderr).not.toContain("actual-key");
    expect(stderr).toContain('"uploads":1');
    await expect(fetch(report.api)).rejects.toThrow();
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon state is private, later processes can reach it, authenticated stop removes state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-proxy-"));
  const state = join(directory, "session.json");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });

  const child = Bun.spawn(
    [
      ...(Bun.env.TCACHE_TEST_BINARY
        ? [Bun.env.TCACHE_TEST_BINARY]
        : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
      "proxy",
      "--state",
      state,
    ],
    {
      env: {
        ...Bun.env,
        TCACHE_API: upstream.url.origin,
        TCACHE_TEAM: "org",
        TCACHE_PROJECT: "project",
        TCACHE_API_KEY: "key",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  try {
    for (let i = 0; i < 100 && !(await Bun.file(state).exists()); i++) await Bun.sleep(20);
    const values = await Bun.file(state).json();
    expect(values.TURBO_TOKEN).not.toBe("key");

    const later = Bun.spawn(
      [
        "bun",
        "-e",
        "const r=await fetch(Bun.env.TURBO_API+'/v8/artifacts/status',{headers:{authorization:'Bearer '+Bun.env.TURBO_TOKEN}});process.exit(r.status===200?0:1)",
      ],
      { env: { ...Bun.env, ...values } },
    );

    expect(await later.exited).toBe(0);

    const stop = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY
          ? [Bun.env.TCACHE_TEST_BINARY]
          : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
        "proxy-stop",
        "--state",
        state,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    expect(await stop.exited).toBe(0);
    expect(await child.exited).toBe(0);
    expect(await Bun.file(state).exists()).toBe(false);
  } finally {
    child.kill();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("proxy refreshes in background and retries safe reads without replaying uploads", async () => {
  let exchanges = 0;
  let reads = 0;
  let puts = 0;
  const authorizations: string[] = [];

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request): Response => {
      if (new URL(request.url).pathname === "/oidc/exchange") {
        exchanges++;

        return Response.json({
          api: upstream.url.origin,
          team: "org",
          project: "project",
          scope: "read write",
          token: `cache-${exchanges}`,
          expiresAt: new Date(Date.now() + 2200).toISOString(),
        });
      }

      authorizations.push(request.headers.get("authorization") ?? "");

      if (request.method === "PUT") {
        puts++;

        return new Response(null, { status: 503 });
      }

      reads++;

      return new Response(null, { status: reads < 3 ? 503 : 200 });
    },
  });

  const directory = await mkdtemp(join(tmpdir(), "tcache-refresh-"));
  const state = join(directory, "session.json");

  const child = Bun.spawn(
    [
      ...(Bun.env.TCACHE_TEST_BINARY
        ? [Bun.env.TCACHE_TEST_BINARY]
        : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
      "proxy",
      "--state",
      state,
    ],
    {
      env: {
        ...Bun.env,
        TCACHE_API: upstream.url.origin,
        TCACHE_TEAM: "org",
        TCACHE_PROJECT: "project",
        TCACHE_CI_PROVIDER: "custom",
        TCACHE_ID_TOKEN: "ci-assertion",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  try {
    for (let i = 0; i < 100 && !(await Bun.file(state).exists()); i++) await Bun.sleep(20);
    const values = await Bun.file(state).json();
    const headers = { authorization: `Bearer ${values.TURBO_TOKEN}` };
    expect((await fetch(values.TURBO_API + "/v8/artifacts/hash", { headers })).status).toBe(200);
    expect(reads).toBe(3);
    expect(
      (
        await fetch(values.TURBO_API + "/v8/artifacts/hash", {
          headers,
          method: "PUT",
          body: "data",
        })
      ).status,
    ).toBe(503);
    expect(puts).toBe(1);
    await Bun.sleep(2500);
    expect(exchanges).toBeGreaterThan(1);
    await fetch(values.TURBO_API + "/v8/artifacts/hash", { headers });
    expect(authorizations.at(-1)).not.toBe("Bearer cache-1");
  } finally {
    child.kill();
    await child.exited;
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("default exec exchanges a saved developer session and forwards bearer credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tcache-developer-exec-"));
  let exchanges = 0;
  let reads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      if (new URL(request.url).pathname === "/tokens/dev") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("origin")).toBe(server.url.origin);
        expect(request.headers.get("authorization")).toBe("Bearer saved-session");
        expect(await request.json()).toEqual({ team: "org", project: "project" });
        exchanges++;
        return Response.json({
          token: "developer-cache-token",
          api: server.url.origin,
          team: "org",
          project: "project",
          scope: "read",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        });
      }
      // The server rejects a DPoP scheme/proof on an unbound developer token.
      if (
        request.headers.get("authorization") !== "Bearer developer-cache-token" ||
        request.headers.has("dpop")
      )
        return new Response(null, { status: 401 });
      reads++;
      return new Response("cached artifact");
    },
  });
  try {
    const config = join(directory, ".config", "tcache");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, "session.json"),
      JSON.stringify({ api: server.url.origin, token: "saved-session" }),
      { mode: 0o600 },
    );
    const script = join(directory, "child.ts");
    await Bun.write(
      script,
      `const response = await fetch(Bun.env.TURBO_API + '/v8/artifacts/hash', { headers: { authorization: 'Bearer ' + Bun.env.TURBO_TOKEN } }); if (response.status !== 200 || await response.text() !== 'cached artifact') process.exit(1);`,
    );
    const child = Bun.spawn(
      [
        ...(Bun.env.TCACHE_TEST_BINARY
          ? [Bun.env.TCACHE_TEST_BINARY]
          : ["bun", new URL("./bin.ts", import.meta.url).pathname]),
        "exec",
        "--",
        "bun",
        script,
      ],
      {
        env: {
          ...Bun.env,
          HOME: directory,
          TCACHE_API: server.url.origin,
          TCACHE_TEAM: "org",
          TCACHE_PROJECT: "project",
          TCACHE_API_KEY: undefined,
          TCACHE_CI_PROVIDER: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(exchanges).toBe(1);
    expect(reads).toBe(1);
    expect(stderr).not.toContain("saved-session");
    expect(stderr).not.toContain("developer-cache-token");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
