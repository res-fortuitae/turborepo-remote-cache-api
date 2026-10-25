import { fileURLToPath } from "node:url";
import { DpopSigner, DpopSignerLive } from "@repo/client-core";
import { Effect, Redacted } from "effect";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Run against an already configured preview. Never deploys or changes trust policy.
const mode = Bun.argv[2];
const api = Bun.env.TCACHE_PREVIEW_API!;
const origin = new URL(api);

if (origin.protocol !== "https:" || origin.origin !== api || origin.username || origin.password)
  throw new Error("Preview API must be a canonical HTTPS origin");

const team = Bun.env.TCACHE_PREVIEW_TEAM!;
const project = Bun.env.TCACHE_PREVIEW_PROJECT!;

if (!team || !project) throw new Error("Preview team and project are required");

const header = { authorization: `Bearer ${Bun.env.TURBO_TOKEN}` };
const fixtureHash = "e2e452abc";
const marker = "OIDC preview fixture\n";

const githubToken = async () => {
  const url = new URL(Bun.env.ACTIONS_ID_TOKEN_REQUEST_URL!);

  if (url.protocol !== "https:") throw new Error("GitHub identity endpoint must be HTTPS");
  url.searchParams.set("audience", api);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error("GitHub identity unavailable; grant id-token: write");
  const body = await response.json();

  if (typeof body.value !== "string" || body.value.length > 16_384)
    throw new Error("Invalid GitHub identity response");
  console.log(`::add-mask::${body.value}`);

  return body.value;
};

const exchangeStatus = async (token: string) => {
  const proof = await Effect.runPromise(
    Effect.gen(function* () {
      const signer = yield* DpopSigner;

      return yield* signer.proof({ method: "POST", url: api + "/oidc/exchange" });
    }).pipe(Effect.provide(DpopSignerLive)),
  );

  const response = await fetch(api + "/oidc/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", dpop: Redacted.value(proof) },
    body: JSON.stringify({ token, team, project }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });

  await response.body?.cancel();

  return response.status;
};

if (mode === "denied") {
  // Invoke this reusable workflow FROM a repository whose immutable ID is outside policy.
  if ((await exchangeStatus(await githubToken())) !== 403)
    throw new Error("Outside repository was not denied");
  console.log("Outside-repository denial confirmed.");
} else if (mode === "expired") {
  const token = await githubToken();
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  // This unverified decode determines a wait only, never an authorization decision.
  const until = Number(payload.exp) * 1000 + 61_000;

  if (!Number.isFinite(until) || until < Date.now() || until > Date.now() + 20 * 60_000)
    throw new Error("Unexpected CI token expiry; refusing unbounded wait");

  while (Date.now() < until) await Bun.sleep(Math.min(30_000, until - Date.now()));

  if ((await exchangeStatus(token)) !== 403) throw new Error("Expired assertion was accepted");
  console.log("Expired GitHub assertion rejection confirmed.");
} else if (mode === "write" || mode === "read") {
  const target = `${Bun.env.TURBO_API}/v8/artifacts/${fixtureHash}`;

  const upload = await fetch(target, {
    method: "PUT",
    headers: { ...header, "content-length": String(new TextEncoder().encode(marker).length) },
    body: marker,
  });

  if (upload.status !== (mode === "write" ? 202 : 403))
    throw new Error("Preview write permission did not match expected role");
  const download = await fetch(target, { headers: header });

  if (download.status !== 200 || (await download.text()) !== marker)
    throw new Error("Preview fixture missing; prime it from main first");
  const directory = await mkdtemp(join(tmpdir(), "preview-turbo-"));

  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "oidc-preview-e2e",
        private: true,
        packageManager: `bun@${Bun.version}`,
        scripts: { build: "bun build.ts" },
      }),
    );
    await writeFile(
      join(directory, "turbo.json"),
      JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }),
    );
    await writeFile(
      join(directory, "build.ts"),
      'await Bun.write("dist/result.txt", "preview remote restore\\n");\n',
    );

    const install = Bun.spawn(["bun", "install"], {
      cwd: directory,
      stdout: "ignore",
      stderr: "ignore",
    });

    if ((await install.exited) !== 0) throw new Error("Fixture install failed");
    const turbo = fileURLToPath(new URL("../node_modules/.bin/turbo", import.meta.url));

    const child = Bun.spawn(
      [
        turbo,
        "run",
        "build",
        mode === "write" ? "--cache=remote:rw" : "--cache=remote:r",
        ...(mode === "write" ? ["--force"] : []),
      ],
      { cwd: directory, env: Bun.env, stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code !== 0 || (mode === "read" && !/cache hit/.test(stdout + stderr)))
      throw new Error("Preview Turbo round trip failed");

    if ((await readFile(join(directory, "dist/result.txt"), "utf8")) !== "preview remote restore\n")
      throw new Error("Preview output was not restored");
    console.log(`Preview ${mode} permission and real Turbo cache check passed.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else throw new Error("Expected write, read, denied or expired");
