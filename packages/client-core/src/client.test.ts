/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test entry point. */
import { expect, test } from "bun:test";
import { Forbidden, RateLimited, ServiceUnavailable } from "@repo/api-spec";
import { Clock, Effect, FileSystem, Layer, Predicate, Redacted, Result, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  calculateJwkThumbprint,
  decodeJwt,
} from "jose";
import {
  ClientAuthError,
  ClientConfig,
  ClientConfigLive,
  ClientEnvironment,
  ClientMessages,
  ClientOptions,
  ClientCommand,
  CiProvider,
  CiProviderLive,
  ExchangeClient,
  ExchangeClientLive,
  DpopSigner,
  DpopSignerLive,
  TokenCache,
  TokenCacheLive,
  DeveloperCredentials,
  DeveloperCredentialsUnavailable,
  ClientCoreLive,
  authOrDisabled,
  type ClientFlags,
} from "./index.ts";

const api = "https://cache.example";
const ciSecret = "secret-ci-token";
const cacheSecret = "secret-cache-token";

const config = {
  api,
  audience: api,
  team: "org",
  project: "prj",
  strict: false,
  boundTokens: false,
  apiKeysAllowed: true,
};

const memoryFiles = (files: Record<string, string>) =>
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      exists: (path) => Effect.succeed(Object.hasOwn(files, path)),
      stream: (path) => Stream.fromIterable([new TextEncoder().encode(files[path] ?? "")]),
    }),
  );

const reason = <A, R>(task: Effect.Effect<A, ClientAuthError, R>) =>
  Effect.map(Effect.result(task), (result) =>
    Result.isFailure(result) ? result.failure.reason : undefined,
  );

const fixture = (
  options: {
    env?: Record<string, string>;
    files?: Record<string, string>;
    header?: string;
    flags?: ClientFlags;
    response?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
    apiKeysAllowed?: boolean;
    developer?: typeof DeveloperCredentials.Service;
  } = {},
) => {
  const env = options.env ?? { GITLAB_CI: "true", CACHE_ID_TOKEN: ciSecret };
  const files = options.files ?? {};
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const warnings: string[] = [];
  const masks: string[] = [];
  const commands: { executable: string; args: readonly string[] }[] = [];

  const messages = Layer.succeed(ClientMessages, {
    warn: (message: string) =>
      Effect.sync(() => {
        warnings.push(message);
      }),
    mask: (token: Redacted.Redacted<string>) =>
      Effect.sync(() => {
        masks.push(Redacted.value(token));
      }),
  });

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push(request);

        const response = options.response
          ? yield* options.response(request)
          : Response.json({
              token: cacheSecret,
              expiresAt: new Date((yield* Clock.currentTimeMillis) + 120_000).toISOString(),
              api,
              team: "org",
              project: "prj",
              scope: "read write",
            });

        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );

  const adapters = Layer.mergeAll(
    messages,
    http,
    memoryFiles(files),
    Layer.succeed(ClientEnvironment, { get: (key) => env[key], header: () => options.header }),
    Layer.succeed(ClientCommand, {
      run: (executable, args) =>
        Effect.sync(() => {
          commands.push({ executable, args });

          return ciSecret;
        }),
    }),
    Layer.succeed(ClientConfig, {
      ...config,
      ...options.flags,
      apiKeysAllowed: options.apiKeysAllowed ?? true,
      apiKey: env.TCACHE_API_KEY ? Redacted.make(env.TCACHE_API_KEY) : undefined,
    }),
  );

  const services = Layer.mergeAll(
    CiProviderLive,
    ExchangeClientLive,
    DpopSignerLive,
    options.developer
      ? Layer.succeed(DeveloperCredentials, options.developer)
      : DeveloperCredentialsUnavailable,
  ).pipe(Layer.provideMerge(adapters));

  const layer = TokenCacheLive.pipe(
    Layer.provideMerge(services),
    Layer.provideMerge(TestClock.layer()),
  );

  return { env, files, requests, warnings, masks, commands, layer, adapters, messages };
};

type TestEnv = TokenCache | CiProvider | ExchangeClient | DpopSigner | TestClock.TestClock;

const run = <A, E>(task: Effect.Effect<A, E, TestEnv>, f = fixture()) =>
  Effect.runPromise(task.pipe(Effect.provide(f.layer)));

const configure = (
  flags: ClientFlags,
  env: Record<string, string>,
  files: Record<string, string>,
) =>
  ClientConfigLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ClientEnvironment, { get: (key) => env[key] }),
        Layer.succeed(ClientOptions, { flags }),
        memoryFiles(files),
      ),
    ),
  );

test("config resolves flags > environment > linked project and keeps keys redacted", async () => {
  const layer = configure(
    { project: "flag", strict: false },
    { TCACHE_TEAM: "env", TCACHE_STRICT: "true", TCACHE_API_KEY: "key" },
    {
      ".turbo-cache.json": JSON.stringify({
        api: `${api}/`,
        team: "file",
        project: "file",
        projectSlug: "friendly",
      }),
    },
  );

  const value = await Effect.runPromise(
    ClientConfig.use(Effect.succeed).pipe(Effect.provide(layer)),
  );

  expect(value).toMatchObject({ api, audience: api, team: "env", project: "flag", strict: false });
  expect(JSON.stringify(value)).not.toContain('"key"');
  expect(Redacted.value(value.apiKey!)).toBe("key");
});

test("invalid config and oversized files become actionable failures; startup can fail open", async () => {
  for (const address of [
    "http://public.example",
    "https://user:secret@example.com",
    `${api}/prefix`,
    `${api}?token=secret`,
  ]) {
    expect(
      await Effect.runPromise(
        reason(
          ClientConfig.use(Effect.succeed).pipe(
            Effect.provide(configure({ api: address, team: "org", project: "p" }, {}, {})),
          ),
        ),
      ),
    ).toBe("configuration");
  }

  const f = fixture();

  const task = ClientConfig.use(Effect.succeed).pipe(
    Effect.provide(configure({}, {}, { ".turbo-cache.json": "x".repeat(17_000) })),
  );

  expect(
    await Effect.runPromise(authOrDisabled(task).pipe(Effect.provide(f.messages))),
  ).toBeUndefined();
  expect(f.warnings.length).toBe(1);
  expect(
    await Effect.runPromise(reason(authOrDisabled(task, true)).pipe(Effect.provide(f.messages))),
  ).toBe("configuration");
});

test("GitHub obtains an audience-specific token and masks request + identity credentials", () => {
  const f = fixture({
    env: {
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?audience=old",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
    },
    response: () => Effect.succeed(Response.json({ value: ciSecret })),
  });

  return run(
    Effect.gen(function* () {
      const provider = yield* CiProvider;
      expect(yield* provider.detect).toBe("github");
      expect(Redacted.value(yield* provider.token)).toBe(ciSecret);
      expect(new URL(f.requests[0]!.url).searchParams.get("audience")).toBe(api);
      expect(f.requests[0]!.headers.authorization).toBe("Bearer request-secret");
      expect(f.masks).toEqual(["request-secret", ciSecret]);
    }),
    f,
  );
});

test("missing GitHub permission is typed; invalid explicit provider is never a defect", () => {
  const f = fixture({ env: { GITHUB_ACTIONS: "true" } });

  return run(
    Effect.gen(function* () {
      const provider = yield* CiProvider;
      expect(yield* reason(provider.token)).toBe("permission");
      f.env.TCACHE_CI_PROVIDER = "unknown";
      expect(yield* reason(provider.detect)).toBe("configuration");
      expect(yield* reason(provider.token)).toBe("configuration");
      expect(f.requests).toHaveLength(0);
    }),
    f,
  );
});

const vercelResponse = (request: HttpClientRequest.HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) throw new Error("Expected JSON");
  const body = JSON.parse(new TextDecoder().decode(request.body.body));
  expect(request.url).toBe("https://oidc.vercel.com/~token");
  expect(body.aud).toBe(api);
  expect(body.jti).toMatch(/^[0-9a-f-]{36}$/);

  return Effect.succeed(Response.json({ token: body.token }));
};

test("Vercel header wins; files are reread before env and missing files never downgrade", async () => {
  const header = fixture({
    env: { VERCEL: "1", VERCEL_OIDC_TOKEN_FILE: "token", VERCEL_OIDC_TOKEN: "env" },
    files: { token: "file" },
    header: "header",
    response: vercelResponse,
  });

  await run(
    CiProvider.use((provider) =>
      Effect.map(provider.token, (token) => {
        expect(Redacted.value(token)).toBe("header");
      }),
    ),
    header,
  );

  const f = fixture({
    env: { VERCEL: "1", VERCEL_OIDC_TOKEN_FILE: "token", VERCEL_OIDC_TOKEN: "env" },
    files: { token: "first" },
    response: vercelResponse,
  });

  await run(
    Effect.gen(function* () {
      const provider = yield* CiProvider;
      expect(Redacted.value(yield* provider.token)).toBe("first");
      f.files.token = "second";
      expect(Redacted.value(yield* provider.token)).toBe("second");
      delete f.files.token;
      expect(yield* reason(provider.token)).toBe("missing_token");
      delete f.env.VERCEL_OIDC_TOKEN_FILE;
      expect(Redacted.value(yield* provider.token)).toBe("env");
    }),
    f,
  );
});

test("CI environment readers and projected tokens do not require provider SDKs", async () => {
  for (const [env, expected] of [
    [{ GITLAB_CI: "true", CACHE_ID_TOKEN: ciSecret }, "gitlab"],
    [{ CIRCLECI: "true", CIRCLE_OIDC_TOKEN_V2: ciSecret }, "circleci"],
    [{ BITBUCKET_STEP_OIDC_TOKEN: ciSecret }, "bitbucket"],
    [{ AWS_WEB_IDENTITY_TOKEN_FILE: "token" }, "aws-eks"],
    [{ AZURE_FEDERATED_TOKEN_FILE: "token" }, "azure"],
    [{ TCACHE_OIDC_TOKEN_FILE: "token" }, "custom"],
  ] as const) {
    const f = fixture({ env, files: { token: ciSecret } });
    await run(
      Effect.gen(function* () {
        const provider = yield* CiProvider;
        expect(yield* provider.detect).toBe(expected);
        expect(Redacted.value(yield* provider.token)).toBe(ciSecret);
        expect(f.requests).toHaveLength(0);
      }),
      f,
    );
  }
});

test("Buildkite executes argv without a shell; Google metadata is audience-specific and opt-in", async () => {
  const f = fixture({ env: { BUILDKITE: "true" } });
  await run(
    CiProvider.use((provider) => provider.token),
    f,
  );
  expect(f.commands).toEqual([
    { executable: "buildkite-agent", args: ["oidc", "request-token", "--audience", api] },
  ]);

  const google = fixture({
    env: { TCACHE_CI_PROVIDER: "google" },
    response: () => Effect.succeed(new Response(ciSecret)),
  });

  await run(
    CiProvider.use((provider) => provider.token),
    google,
  );
  expect(google.requests[0]!.headers["metadata-flavor"]).toBe("Google");
  expect(google.requests[0]!.url).toContain("metadata.google.internal");
  expect(new URL(google.requests[0]!.url).searchParams.get("audience")).toBe(api);
});

test("generated HttpApiClient sends the shared exchange payload and optional proof", () => {
  const f = fixture();

  return run(
    Effect.gen(function* () {
      const client = yield* ExchangeClient;
      const response = yield* client.exchange(Redacted.make(ciSecret), Redacted.make("proof"));
      expect(Redacted.value(response.token)).toBe(cacheSecret);
      const request = f.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`${api}/oidc/exchange`);
      expect(request.headers.dpop).toBe("proof");

      if (!Predicate.isTagged(request.body, "Uint8Array")) throw new Error("Expected JSON body");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        token: ciSecret,
        team: "org",
        project: "prj",
      });
    }),
    f,
  );
});

test("exchange errors are typed/redacted; wrong tenant, expired and oversized replies are rejected", async () => {
  for (const [response, expected] of [
    [Response.json(new Forbidden({ message: ciSecret }), { status: 403 }), "policy_denied"],
    [Response.json(new RateLimited({ message: ciSecret }), { status: 429 }), "rate_limited"],
    [
      Response.json({
        token: cacheSecret,
        api,
        team: "other",
        project: "prj",
        scope: "read",
        expiresAt: new Date(120_000).toISOString(),
      }),
      "invalid_response",
    ],
    [
      Response.json({
        token: cacheSecret,
        api,
        team: "org",
        project: "prj",
        scope: "read",
        expiresAt: new Date(0).toISOString(),
      }),
      "invalid_response",
    ],
    [Response.json(new ServiceUnavailable({ message: ciSecret }), { status: 503 }), "unreachable"],
    [new Response("secret".repeat(20_000)), "invalid_response"],
    [
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      "invalid_response",
    ],
  ] as const) {
    const f = fixture({ response: () => Effect.succeed(response) });
    await run(
      Effect.gen(function* () {
        const client = yield* ExchangeClient;
        const result = yield* Effect.result(client.exchange(Redacted.make(ciSecret)));
        expect(Result.isFailure(result) && result.failure.reason).toBe(expected);
        expect(JSON.stringify(result)).not.toContain(ciSecret);
        expect(JSON.stringify(result)).not.toContain(cacheSecret);
      }),
      f,
    );
  }
});

test("memory cache coalesces job setup, refreshes near expiry and peek never exchanges", () => {
  const f = fixture();

  return run(
    Effect.gen(function* () {
      const cache = yield* TokenCache;
      expect(yield* cache.peek).toBeUndefined();

      const grants = yield* Effect.all(
        Array.from({ length: 12 }, () => cache.get),
        { concurrency: "unbounded" },
      );

      expect(grants.every((grant) => grant?.source === "oidc")).toBe(true);
      expect(f.requests).toHaveLength(1);
      yield* cache.get;
      yield* cache.peek;
      expect(f.requests).toHaveLength(1);
      yield* TestClock.adjust(95_000);
      yield* cache.get;
      expect(f.requests).toHaveLength(2);
      yield* TestClock.adjust(130_000);
      expect(yield* cache.peek).toBeUndefined();
      expect(f.requests).toHaveLength(2);
      expect(f.masks).toContain(ciSecret);
      expect(f.masks).toContain(cacheSecret);
    }),
    f,
  );
});

test("failure defaults to remote disabled with one safe warning; strict fails and refresh cooldown coalesces", async () => {
  for (const strict of [false, true]) {
    const f = fixture({
      flags: { strict },
      response: () =>
        Effect.succeed(
          Response.json(new Forbidden({ message: `secret ${ciSecret}` }), { status: 403 }),
        ),
    });

    await run(
      Effect.gen(function* () {
        const cache = yield* TokenCache;

        const results = yield* Effect.all(
          Array.from({ length: 6 }, () => Effect.result(cache.get)),
          { concurrency: "unbounded" },
        );

        expect(
          results.every((result) =>
            strict
              ? Result.isFailure(result)
              : Result.isSuccess(result) && result.success === undefined,
          ),
        ).toBe(true);
        expect(f.requests).toHaveLength(1);
        expect(f.warnings).toHaveLength(1);
        expect(f.warnings.join("")).not.toContain(ciSecret);
        expect(yield* cache.peek).toBeUndefined();
        yield* TestClock.adjust(31_000);
        yield* Effect.result(cache.get);
        expect(f.requests).toHaveLength(2);
      }),
      f,
    );
  }
});

test("API-key fallback only when no OIDC; policy can disable it, laptop requests login", async () => {
  const key = fixture({ env: { TCACHE_API_KEY: "api-key-secret" } });
  await run(
    Effect.gen(function* () {
      const cache = yield* TokenCache;
      expect((yield* cache.get)?.source).toBe("apiKey");
      yield* cache.get;
      expect(key.requests).toHaveLength(0);
      expect(key.masks).toEqual(["api-key-secret"]);
    }),
    key,
  );

  const disabled = fixture({
    env: { TCACHE_API_KEY: "api-key-secret" },
    apiKeysAllowed: false,
    flags: { strict: true },
  });

  await run(
    TokenCache.use((cache) =>
      Effect.map(reason(cache.get), (value) => {
        expect(value).toBe("api_keys_disallowed");
      }),
    ),
    disabled,
  );
  const laptop = fixture({ env: {}, flags: { strict: true } });
  await run(
    TokenCache.use((cache) =>
      Effect.map(reason(cache.get), (value) => {
        expect(value).toBe("login_required");
      }),
    ),
    laptop,
  );

  const oidc = fixture({
    env: { GITHUB_ACTIONS: "true", TCACHE_API_KEY: "key" },
    flags: { strict: true },
  });

  await run(
    TokenCache.use((cache) =>
      Effect.map(reason(cache.get), (value) => {
        expect(value).toBe("permission");
      }),
    ),
    oidc,
  );
});

test("DPoP uses a per-job ES256 key, fresh jti, normalized URL, ath and nonce", () =>
  run(
    Effect.gen(function* () {
      const signer = yield* DpopSigner;

      const proof = Redacted.value(
        yield* signer.proof({
          url: `${api}/v8/artifacts/hash?team=org#ignored`,
          method: "get",
          accessToken: Redacted.make("access"),
          nonce: "server-nonce",
        }),
      );

      const header = decodeProtectedHeader(proof);
      expect(header.typ).toBe("dpop+jwt");
      expect(header.alg).toBe("ES256");

      if (!header.jwk) throw new Error("Missing public key");
      expect(Object.hasOwn(header.jwk, "d")).toBe(false);
      const publicKey = yield* Effect.promise(() => importJWK(header.jwk!, "ES256"));

      const verified = yield* Effect.promise(() =>
        jwtVerify(proof, publicKey, { algorithms: ["ES256"] }),
      );

      expect(verified.payload).toMatchObject({
        htm: "GET",
        htu: `${api}/v8/artifacts/hash`,
        iat: 0,
        nonce: "server-nonce",
      });

      const expected = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode("access")),
      );

      expect(verified.payload.ath).toBe(
        btoa(String.fromCharCode(...new Uint8Array(expected)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      );
      expect(yield* Effect.promise(() => calculateJwkThumbprint(header.jwk!))).toBe(
        signer.thumbprint,
      );
      const next = Redacted.value(yield* signer.proof({ url: api, method: "POST" }));
      expect(decodeJwt(next).jti).not.toBe(verified.payload.jti);
      const nextHeader = decodeProtectedHeader(next);
      expect(nextHeader.jwk).toEqual(header.jwk);
      expect(yield* reason(signer.proof({ url: "invalid", method: "GET" }))).toBe("dpop");
    }),
  ));

test("refresh rereads projected CI identity; clearing starts a fresh job acquisition", () => {
  const f = fixture({
    env: { AWS_WEB_IDENTITY_TOKEN_FILE: "token" },
    files: { token: "first-ci" },
  });

  return run(
    Effect.gen(function* () {
      const cache = yield* TokenCache;
      yield* cache.get;
      f.files.token = "rotated-ci";
      yield* TestClock.adjust(95_000);
      yield* cache.get;
      const last = f.requests[1]!;

      if (!Predicate.isTagged(last.body, "Uint8Array")) throw new Error("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(last.body.body)).token).toBe("rotated-ci");
      yield* cache.clear;
      expect(yield* cache.peek).toBeUndefined();
      yield* cache.get;
      expect(f.requests).toHaveLength(3);
    }),
    f,
  );
});

test("ClientCoreLive composes from platform adapters and resolves configuration", () => {
  const f = fixture();

  const layer = ClientCoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        f.adapters,
        DeveloperCredentialsUnavailable,
        Layer.succeed(ClientOptions, { flags: { api, team: "org", project: "prj" } }),
      ),
    ),
    Layer.provide(TestClock.layer()),
  );

  return Effect.runPromise(
    TokenCache.use((cache) =>
      Effect.map(cache.get, (value) => {
        expect(value?.source).toBe("oidc");
        expect(f.requests).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
  );
});

test("injected developer credentials refresh and mask optional signature keys", () => {
  let acquisitions = 0;

  const f = fixture({
    env: {},
    developer: {
      acquire: Effect.gen(function* () {
        acquisitions++;

        return {
          token: Redacted.make(cacheSecret),
          signatureKey: Redacted.make("signature-secret"),
          expiresAt: new Date((yield* Clock.currentTimeMillis) + 120_000).toISOString(),
          api,
          team: "org",
          project: "prj",
          scope: "read" as const,
        };
      }),
    },
  });

  return run(
    Effect.gen(function* () {
      const cache = yield* TokenCache;
      expect((yield* cache.get)?.source).toBe("developer");
      yield* cache.get;
      expect(acquisitions).toBe(1);
      expect(f.masks).toEqual([cacheSecret, "signature-secret"]);
      yield* TestClock.adjust(95_000);
      yield* cache.get;
      expect(acquisitions).toBe(2);
      expect(f.requests).toHaveLength(0);
    }),
    f,
  );
});

test("Vercel exchanges freshly on each refresh, masks source and never exposes provider errors", async () => {
  const f = fixture({
    env: { VERCEL: "1", VERCEL_OIDC_TOKEN: "source-secret" },
    response: () => Effect.succeed(Response.json({ token: "audience-token" })),
  });

  await run(
    Effect.gen(function* () {
      const provider = yield* CiProvider;
      expect(Redacted.value(yield* provider.token)).toBe("audience-token");
      yield* provider.token;
      expect(f.requests).toHaveLength(2);

      const bodies = f.requests.map((request) => {
        if (!Predicate.isTagged(request.body, "Uint8Array")) throw new Error("Expected JSON");

        return JSON.parse(new TextDecoder().decode(request.body.body));
      });

      expect(bodies[0].jti).not.toBe(bodies[1].jti);
      expect(f.masks).toEqual([
        "source-secret",
        "audience-token",
        "source-secret",
        "audience-token",
      ]);
    }),
    f,
  );

  for (const response of [
    Response.json({ error: "source-secret" }, { status: 403 }),
    Response.json({ error: "source-secret" }),
    Response.json({ token: "x".repeat(70000) }),
  ]) {
    const bad = fixture({
      env: { VERCEL: "1", VERCEL_OIDC_TOKEN: "source-secret" },
      response: () => Effect.succeed(response),
    });

    await run(
      Effect.gen(function* () {
        const result = yield* Effect.result((yield* CiProvider).token);
        expect(Result.isFailure(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("source-secret");
      }),
      bad,
    );
  }
});
