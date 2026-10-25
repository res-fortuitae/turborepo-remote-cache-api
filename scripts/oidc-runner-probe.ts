import { fork } from "node:child_process";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (Bun.argv[2] === "start") {
  const directory = await mkdtemp(join(Bun.env.RUNNER_TEMP ?? tmpdir(), "tcache-lifecycle-"));

  const child = fork(new URL("./oidc-runner-upstream.mjs", import.meta.url), [directory], {
    detached: true,
    stdio: "ignore",
    execArgv: [],
    execPath: "node",
  });

  child.unref();
  let data: { api: string } | undefined;

  for (let i = 0; i < 100; i++) {
    try {
      data = JSON.parse(await readFile(join(directory, "upstream.json"), "utf8"));
      break;
    } catch {
      await Bun.sleep(50);
    }
  }

  if (!data) {
    child.kill();
    throw new Error("Runner fixture did not become ready");
  }

  await appendFile(
    Bun.env.GITHUB_ENV!,
    `TCACHE_PROBE_API=${data.api}\nTCACHE_PROBE_DIRECTORY=${directory}\nTCACHE_CI_PROVIDER=custom\nTCACHE_ID_TOKEN=runner-lifecycle-fixture\n`,
  );
} else if (Bun.argv[2] === "check") {
  const directory = Bun.env.TCACHE_PROBE_DIRECTORY!;
  await writeFile(join(directory, "checked.json"), JSON.stringify({ api: Bun.env.TURBO_API }), {
    mode: 0o600,
  });
  await Bun.sleep(3000); // Cross-step probe deliberately outlives the initial fixture credential.
  const headers = { authorization: `Bearer ${Bun.env.TURBO_TOKEN}` };
  const response = await fetch(`${Bun.env.TURBO_API}/v8/artifacts/abc`, { headers });

  if (!response.ok || (await response.text()) !== "fixture")
    throw new Error("Later step cannot use refreshed proxy");

  const put = await fetch(`${Bun.env.TURBO_API}/v8/artifacts/abc`, {
    method: "PUT",
    headers: { ...headers, "content-length": "3" },
    body: "abc",
  });

  if (put.status !== 202) throw new Error("Later step upload failed");
  const state = JSON.parse(await readFile(join(directory, "upstream.json"), "utf8"));

  const stats = await fetch(`${state.api}/_probe/stats`, {
    headers: { authorization: `Bearer ${state.secret}` },
  }).then((value) => value.json());

  if (stats.exchanges < 2 || stats.proofs < 2)
    throw new Error("Refresh/proof generation not observed");
  console.log("Cross-step proxy, refresh and streaming checks passed.");
} else throw new Error("Expected start or check");
