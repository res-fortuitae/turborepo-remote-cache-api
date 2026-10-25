import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deliberately run shipped bundles with Node 24: the Action must not need Bun at runtime.
const dist = new URL("../dist/", import.meta.url).pathname;

const fixture = async (mode: "proxy" | "env", status = 200, strict = false) => {
  const directory = await mkdtemp(join(tmpdir(), "action-test-"));

  const files = {
    GITHUB_ENV: join(directory, "env"),
    GITHUB_STATE: join(directory, "state"),
    GITHUB_STEP_SUMMARY: join(directory, "summary"),
  };

  for (const file of Object.values(files)) await writeFile(file, "");
  let exchanges = 0;
  let uploadedBytes = 0;
  const requests: Headers[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      if (new URL(request.url).pathname === "/oidc/exchange") {
        exchanges++;

        if (status !== 200)
          return Response.json(
            { _tag: "Forbidden", code: "forbidden", message: "policy denied" },
            { status },
          );

        return Response.json({
          api: server.url.origin,
          team: "org",
          project: "p",
          token: "actual-cache-secret",
          scope: "read write",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          signatureKey: "artifact-signature-secret",
        });
      }

      requests.push(new Headers(request.headers));

      if (request.method === "PUT") {
        for await (const chunk of request.body!) uploadedBytes += chunk.byteLength;

        return new Response(null, { status: 202 });
      }

      return new Response(request.method === "HEAD" ? null : "artifact", {
        headers: { "content-length": "8" },
      });
    },
  });

  const env = {
    ...Bun.env,
    ...files,
    RUNNER_TEMP: directory,
    INPUT_API: server.url.origin,
    INPUT_TEAM: "org",
    INPUT_PROJECT: "p",
    INPUT_MODE: mode,
    INPUT_STRICT: String(strict),
    TCACHE_CI_PROVIDER: "custom",
    TCACHE_ID_TOKEN: "ci-secret",
  };

  const run = async (entry: string, extra: Record<string, string> = {}) => {
    const child = Bun.spawn(["node", join(dist, entry)], {
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;

    return { code, stdout, stderr };
  };

  const stateDirectory = async () => {
    const data = await readFile(files.GITHUB_STATE, "utf8");

    return data.split("\n")[1]!;
  };

  return {
    run,
    files,
    requests,
    get uploadedBytes() {
      return uploadedBytes;
    },
    get exchanges() {
      return exchanges;
    },
    stateDirectory,
    async close() {
      const state = await stateDirectory();

      if (state) await run("post.cjs", { STATE_directory: state });
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("shipped node24 proxy survives main exit, streams across steps, masks and post stops with stats", async () => {
  const f = await fixture("proxy");

  try {
    const result = await f.run("main.cjs");
    expect(result.code).toBe(0);
    const directory = await f.stateDirectory();
    const values = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
    expect(values.TURBO_TOKEN).not.toBe("actual-cache-secret");
    expect(await readFile(f.files.GITHUB_ENV, "utf8")).not.toContain("actual-cache-secret");
    expect(result.stdout).toContain("::add-mask::ci-secret");
    expect((await fetch(values.TURBO_API + "/v8/artifacts/abc")).status).toBe(401);
    const download = await fetch(values.TURBO_API + "/v8/artifacts/abc", {
      headers: { authorization: `Bearer ${values.TURBO_TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("artifact");
    expect(f.requests[0]?.get("authorization")).toBe("DPoP actual-cache-secret");
    expect(f.requests[0]?.get("dpop")?.split(".")).toHaveLength(3);
    const upload = await fetch(values.TURBO_API + "/v8/artifacts/abc", {
      method: "PUT",
      headers: { authorization: `Bearer ${values.TURBO_TOKEN}`, "content-length": "1048576" },
      body: new Uint8Array(1048576),
    });
    expect(upload.status).toBe(202);
    expect(f.uploadedBytes).toBe(1048576);
    const head = await fetch(values.TURBO_API + "/v8/artifacts/abc", {
      method: "HEAD",
      headers: { authorization: `Bearer ${values.TURBO_TOKEN}` },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("8");
    const post = await f.run("post.cjs", { STATE_directory: directory });
    expect(post.code).toBe(0);
    expect(await readFile(f.files.GITHUB_STEP_SUMMARY, "utf8")).toContain("Hits");
    await Bun.sleep(100);
    await expect(fetch(values.TURBO_API)).rejects.toThrow();
    expect(await Bun.file(join(directory, "session.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("env mode masks the credential and optional signature before export, without a daemon", async () => {
  const f = await fixture("env");

  try {
    const result = await f.run("main.cjs");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::add-mask::actual-cache-secret");
    expect(result.stdout).toContain("::add-mask::artifact-signature-secret");
    expect(await readFile(f.files.GITHUB_ENV, "utf8")).toContain("actual-cache-secret");
    expect(await readFile(f.files.GITHUB_STATE, "utf8")).toBe("");
    expect(f.exchanges).toBe(1);
  } finally {
    await f.close();
  }
});

for (const strict of [false, true])
  test(`denied identity disables remote cache; strict=${strict}`, async () => {
    const f = await fixture("proxy", 403, strict);

    try {
      const result = await f.run("main.cjs");
      expect(result.code).toBe(strict ? 1 : 0);
      const env = await readFile(f.files.GITHUB_ENV, "utf8");
      expect(env).toContain("local:rw");
      expect(env).not.toContain("actual-cache-secret");
      expect(result.stdout).toContain("id-token");
    } finally {
      await f.close();
    }
  });
