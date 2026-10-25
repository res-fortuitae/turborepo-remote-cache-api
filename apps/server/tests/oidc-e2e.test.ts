import { fileURLToPath } from "node:url";
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Full HTTP/Node Action/Turbo test boundary. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { AuditLogD1Only } from "@repo/audit";
import { AuthorizationDatabaseLive, AuthorizationCeilings } from "@repo/authz";
import { CoordinatorClientTest } from "@repo/coordinator";
import {
  CacheTokenConfig,
  CacheTokenSignerLive,
  CacheTokenVerifierLive,
  KeyStoreTest,
  DpopVerifierLive,
} from "@repo/credentials";
import {
  Database,
  InstanceSettingsRepoLive,
  ProjectRepoLive,
  ReplayGuardLive,
  TrustPolicyRepoLive,
  schema,
} from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin, OidcAudience } from "@repo/deploy-config";
import {
  OidcExchangeLive,
  ExchangeConfigLive,
  OidcVerifierLive,
  OidcVerifierConfig,
  BuiltinIssuerRegistry,
  JwksCacheTest,
  TrustPolicyMatcherLive,
  PolicyGuardrailsLive,
  GITHUB_ACTIONS_ISSUER,
} from "@repo/oidc";
import { AuthorizationAuditLive, ProjectLimits } from "@repo/projects";
import { RateLimiter } from "@repo/ratelimit";
import { artifactApi } from "../src/api.ts";
import { authorizeProjectCache } from "../src/project-cache.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { oidcApi } from "../src/oidc-route.ts";
import { memoryBucket } from "./support/in-process.ts";

/** Real signatures, database, signer, authz, HTTP, shipped Node24 Action and real Turbo.
 * Only GitHub discovery/JWKS and R2 are local fixture adapters; nothing is deployed. */
test("OIDC E2E: main writes, PR restores but cannot PUT, outside repo/expired identity denied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oidc-e2e-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const keys = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-ci", alg: "RS256" };
  const issuer = GITHUB_ACTIONS_ISSUER;
  const bucket = memoryBucket();

  let dispatch: (request: Request) => Promise<Response> = async () =>
    new Response(null, { status: 503 });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => dispatch(request),
  });

  const api = server.url.origin;

  const tokens = Layer.mergeAll(CacheTokenSignerLive, CacheTokenVerifierLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        CoordinatorClientTest,
        KeyStoreTest,
        Layer.succeed(CacheTokenConfig, { issuer: api, maxTtlSeconds: 900 }),
      ),
    ),
  );

  const proof = DpopVerifierLive.pipe(Layer.provide(ReplayGuardLive));

  const verifier = OidcVerifierLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        BuiltinIssuerRegistry,
        JwksCacheTest,
        ReplayGuardLive,
        Layer.succeed(OidcVerifierConfig, {
          allowedIssuers: [issuer],
          maxTokenAgeSeconds: 600,
          clockSkewSeconds: 0,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("openid-configuration")
                    ? { issuer, jwks_uri: `${issuer}/keys` }
                    : { keys: [jwk] },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const exchange = OidcExchangeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        verifier,
        proof,
        tokens,
        AuditLogD1Only,
        ProjectRepoLive,
        TrustPolicyRepoLive,
        InstanceSettingsRepoLive,
        ExchangeConfigLive,
        TrustPolicyMatcherLive,
        PolicyGuardrailsLive,
        Layer.succeed(RateLimiter, { allow: () => Effect.succeed(true) }),
      ),
    ),
  );

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      exchange,
      proof,
      tokens,
      InstanceSettingsRepoLive,
      AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only)),
      AuthorizationDatabaseLive.pipe(
        Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only))),
      ),
      Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100_000_000 }),
      Layer.succeed(AuthorizationCeilings, {}),
    ).pipe(
      Layer.provideMerge(DatabaseTest),
      Layer.provideMerge(
        Layer.mergeAll(Layer.succeed(CanonicalOrigin, api), Layer.succeed(OidcAudience, [api])),
      ),
    ),
  );

  const artifact = artifactApi({
    bucket,
    token: Redacted.make("unused-legacy"),
    authorize: authorizeProjectCache,
    cache: createArtifactCache(false),
    edgeCacheEnabled: false,
    waitUntil: () => Effect.void,
  });

  dispatch = (request) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (new URL(request.url).pathname === "/oidc/exchange") return yield* oidcApi;

        return yield* artifact;
      }).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Effect.map(HttpServerResponse.toWeb),
      ),
    );

  const seed = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;

        const base = {
          issuer,
          requireBoundTokens: true,
          ttlSeconds: 120,
          claims: { aud: [api], repository_id: ["1"], repository_owner_id: ["2"] },
        };

        yield* db.batch((db) => [
          db
            .insert(schema.organization)
            .values({ id: "org", slug: "org", name: "Org", createdAt: new Date(0) }),
          db
            .insert(schema.project)
            .values({ id: "p", orgId: "org", slug: "p", name: "P", createdAt: 0 }),
          db.insert(schema.trustPolicy).values([
            {
              id: "main",
              projectId: "p",
              provider: "github",
              body: {
                ...base,
                scope: "read write",
                claims: { ...base.claims, event_name: ["push"], ref: ["refs/heads/main"] },
              },
              createdBy: "admin",
              createdAt: 0,
            },
            {
              id: "pr",
              projectId: "p",
              provider: "github",
              body: {
                ...base,
                scope: "read",
                claims: { ...base.claims, event_name: ["pull_request"] },
              },
              createdBy: "admin",
              createdAt: 0,
            },
          ]),
        ]);
      }),
    );

  const assertion = (event: "push" | "pull_request", outside = false, expired = false) => {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({
      repository_id: outside ? "99" : "1",
      repository_owner_id: "2",
      event_name: event,
      ref: event === "push" ? "refs/heads/main" : "refs/pull/123/merge",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-ci" })
      .setIssuer(issuer)
      .setAudience(api)
      .setSubject("repo:test/repo")
      .setJti(crypto.randomUUID())
      .setIssuedAt(now - (expired ? 120 : 0))
      .setNotBefore(now - (expired ? 120 : 0))
      .setExpirationTime(now + (expired ? -60 : 300))
      .sign(keys.privateKey);
  };

  const actionDist = fileURLToPath(new URL("../../../packages/action/dist/", import.meta.url));
  const actionPath = actionDist;
  const children: { directory: string; env: Record<string, string | undefined> }[] = [];

  const command = async (
    argv: string[],
    env: Record<string, string | undefined>,
    cwd = workspace,
  ) => {
    const child = Bun.spawn(argv, { env, cwd, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // Never echo Action stdout: it contains add-mask commands with the fixture credentials.
    return { stdout, stderr, code };
  };

  const start = async (idToken: string) => {
    const stateDir = await mkdtemp(join(directory, "step-"));

    const env = {
      ...Bun.env,
      INPUT_API: api,
      INPUT_TEAM: "org",
      INPUT_PROJECT: "p",
      INPUT_MODE: "proxy",
      INPUT_STRICT: "true",
      RUNNER_TEMP: stateDir,
      GITHUB_ENV: join(stateDir, "env"),
      GITHUB_STATE: join(stateDir, "state"),
      GITHUB_STEP_SUMMARY: join(stateDir, "summary"),
      TCACHE_CI_PROVIDER: "custom",
      TCACHE_ID_TOKEN: idToken,
    };

    for (const file of [env.GITHUB_ENV, env.GITHUB_STATE, env.GITHUB_STEP_SUMMARY])
      await writeFile(file, "");
    const result = await command(["node", join(actionPath, "main.cjs")], env);
    expect(result.code, "Action authentication must succeed").toBe(0);
    const proxyDirectory = (await readFile(env.GITHUB_STATE, "utf8")).split("\n")[1]!;

    const values: Record<string, string> = JSON.parse(
      await readFile(join(proxyDirectory, "session.json"), "utf8"),
    );

    children.push({ directory: proxyDirectory, env });

    return values;
  };

  try {
    await seed();
    const main = await start(await assertion("push"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "oidc-e2e",
        private: true,
        packageManager: `bun@${Bun.version}`,
        scripts: { build: "bun build.ts" },
      }),
    );
    await writeFile(
      join(workspace, "turbo.json"),
      JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }),
    );
    await writeFile(
      join(workspace, "build.ts"),
      'await Bun.write("dist/result.txt", "OIDC remote restore\\n");\n',
    );
    expect((await command(["bun", "install"], Bun.env)).code).toBe(0);
    const turbo = fileURLToPath(new URL("../../../node_modules/.bin/turbo", import.meta.url));

    const first = await command([turbo, "run", "build", "--cache=remote:rw"], {
      ...Bun.env,
      ...main,
    });

    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("cache miss");
    expect(bucket.objects.size).toBeGreaterThan(0);
    await rm(join(workspace, "dist"), { recursive: true });
    await rm(join(workspace, ".turbo"), { recursive: true, force: true });
    const pr = await start(await assertion("pull_request"));

    const second = await command([turbo, "run", "build", "--cache=remote:r"], {
      ...Bun.env,
      ...pr,
    });

    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("cache hit");
    expect(await readFile(join(workspace, "dist/result.txt"), "utf8")).toBe(
      "OIDC remote restore\n",
    );

    const rejectedPut = await fetch(`${pr.TURBO_API}/v8/artifacts/abcdef`, {
      method: "PUT",
      headers: { authorization: `Bearer ${pr.TURBO_TOKEN}`, "content-length": "1" },
      body: "x",
    });

    expect(rejectedPut.status).toBe(403);

    for (const idToken of [await assertion("push", true), await assertion("push", false, true)]) {
      const response = await fetch(`${api}/oidc/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: idToken, team: "org", project: "p" }),
      });

      expect(response.status).toBe(403);
    }

    const audit = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;

        return yield* db.query("E2E.audit", (db) => db.select().from(schema.auditEvent));
      }),
    );

    expect(audit.some((row) => row.payload.reason === "verification_expired")).toBe(true);
    expect(audit.some((row) => row.payload.reason === "policy_mismatch")).toBe(true);
  } finally {
    for (const child of children)
      await command(["node", join(actionPath, "post.cjs")], {
        ...child.env,
        STATE_directory: child.directory,
      });
    await server.stop(true);
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
