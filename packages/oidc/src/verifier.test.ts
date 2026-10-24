import { describe, expect, test } from "bun:test";
import { ReplayGuard, ReplayGuardLive } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { OidcAudience } from "@repo/deploy-config";
import { Effect, Layer, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  GITHUB_ACTIONS_ISSUER as issuer,
  GitHubIssuerRegistry,
  IssuerRegistry,
  JwksCache,
  JwksCacheTest,
  type Jwks,
  OidcVerifier,
  OidcVerifierLive,
  OidcVerifierConfig,
  OidcVerificationError,
  pruneOidcReplayIds,
} from "./index.ts";

const audience = "https://cache.example";
const first = await generateKeyPair("RS256");
const second = await generateKeyPair("RS256");
const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "first", alg: "RS256", kty: "RSA" };

const secondJwk = {
  ...(await exportJWK(second.publicKey)),
  kid: "second",
  alg: "RS256",
  kty: "RSA",
};

const firstKeys: Jwks = { keys: [firstJwk] };
const secondKeys: Jwks = { keys: [secondJwk] };

const claims: JWTPayload = {
  iss: issuer,
  aud: audience,
  sub: "repo:acme/web:ref:refs/heads/main",
  jti: "run-1",
  iat: 1000,
  nbf: 1000,
  exp: 1300,
  repository_id: "42",
};

const sign = (overrides: JWTPayload = {}, rotated = false) =>
  Effect.promise(() =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: rotated ? "second" : "first" })
      .sign(rotated ? second.privateKey : first.privateKey),
  );

interface DiscoveryFixture {
  readonly issuer: string;
  readonly jwks_uri: string;
}

const http = () => {
  const urls: string[] = [];
  let keys = firstKeys;
  let discovery: DiscoveryFixture | undefined;
  let status = 200;

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      urls.push(url.href);

      const body = url.pathname.endsWith("openid-configuration")
        ? (discovery ?? {
            issuer: `${url.origin}${url.pathname.replace("/.well-known/openid-configuration", "")}`,
            jwks_uri: `${issuer}/.well-known/jwks`,
          })
        : keys;

      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );

  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    urls,
    rotate: () => {
      keys = secondKeys;
    },
    discovery: (value: DiscoveryFixture) => {
      discovery = value;
    },
    status: (value: number) => {
      status = value;
    },
    keys: (value: Jwks) => {
      keys = value;
    },
  };
};

type Env =
  | OidcVerifier
  | JwksCache
  | ReplayGuard
  | TestClock.TestClock
  | IssuerRegistry
  | OidcVerifierConfig
  | OidcAudience
  | HttpClient.HttpClient;

const run = <A, E>(
  program: Effect.Effect<A, E, Env>,
  network = http(),
  allowedIssuers = [issuer],
) => {
  const dependencies = Layer.mergeAll(
    network.layer,
    GitHubIssuerRegistry,
    JwksCacheTest,
    ReplayGuardLive.pipe(Layer.provide(DatabaseTest)),
    TestClock.layer(),
    Layer.succeed(OidcAudience, [audience]),
    Layer.succeed(OidcVerifierConfig, {
      allowedIssuers,
      maxTokenAgeSeconds: 600,
      clockSkewSeconds: 30,
    }),
  );

  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.adjust(1_000_000);

      return yield* program;
    }).pipe(Effect.provide(OidcVerifierLive.pipe(Layer.provideMerge(dependencies)))),
  );
};

const verify = (token: string) => OidcVerifier.use((service) => service.verify(token));

const reason = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isFailure(result) && result.failure instanceof OidcVerificationError
      ? result.failure.reason
      : undefined,
  );

describe("OIDC verification", () => {
  test("preserves provider claims and matches an exact configured audience", async () => {
    const network = http();
    await run(
      Effect.gen(function* () {
        const token = yield* sign({ aud: ["other", audience] });
        expect(yield* verify(token)).toMatchObject({
          issuer,
          audience,
          subject: claims.sub,
          tokenId: "run-1",
          expiresAt: 1_300_000,
          claims: { repository_id: "42" },
        });
        yield* verify(yield* sign({ jti: "run-2" }));
        expect(network.urls).toEqual([
          `${issuer}/.well-known/openid-configuration`,
          `${issuer}/.well-known/jwks`,
        ]);
      }),
      network,
    );
  });

  test("rejects unregistered issuers before HTTP, even when instance policy lists them", async () => {
    for (const candidate of [
      "https://evil.example",
      `${issuer}.evil.example`,
      `${issuer}/acme/extra`,
      `${issuer}/acme?x=1`,
    ]) {
      const network = http();
      await run(
        Effect.gen(function* () {
          expect(yield* reason(verify(yield* sign({ iss: candidate })))).toBe("issuer");
          expect(network.urls).toEqual([]);
        }),
        network,
        [candidate],
      );
    }
  });

  test("enterprise issuer requires an explicit instance allowlist entry", async () => {
    const enterprise = `${issuer}/acme`;
    const blocked = http();
    await run(
      Effect.gen(function* () {
        expect(yield* reason(verify(yield* sign({ iss: enterprise })))).toBe("issuer");
        expect(blocked.urls).toEqual([]);
      }),
      blocked,
    );
    await run(
      Effect.gen(function* () {
        expect((yield* verify(yield* sign({ iss: enterprise }))).issuer).toBe(enterprise);
      }),
      http(),
      [enterprise],
    );
  });

  test.each([
    ["wrong audience", { aud: `${audience}/` }, "audience"],
    ["expired", { iat: 400, nbf: 400, exp: 969 }, "expired"],
    ["future nbf", { nbf: 1031 }, "claims"],
    ["future iat", { iat: 1031 }, "claims"],
    ["too old", { iat: 369, nbf: 369 }, "expired"],
    ["unbounded lifetime", { exp: 1601 }, "claims"],
    ["invalid ordering", { nbf: 1300 }, "claims"],
    ["missing subject", { sub: undefined }, "claims"],
    ["missing id", { jti: undefined }, "claims"],
    ["missing iat", { iat: undefined }, "claims"],
    ["missing nbf", { nbf: undefined }, "claims"],
    ["missing exp", { exp: undefined }, "claims"],
    ["fractional date", { iat: 1000.5 }, "claims"],
  ] as const)("rejects %s without consuming the id", async (_label, overrides, expected) => {
    await run(
      Effect.gen(function* () {
        expect(yield* reason(verify(yield* sign(overrides)))).toBe(expected);
        expect((yield* verify(yield* sign())).tokenId).toBe("run-1");
      }),
    );
  });

  test("rejects unsigned, symmetric, tampered and malformed tokens", async () => {
    await run(
      Effect.gen(function* () {
        const token = yield* sign();
        const [header, body, signature] = token.split(".");

        for (const alg of ["none", "HS256", "HS384", "HS512"]) {
          const forgedHeader = Buffer.from(JSON.stringify({ alg, kid: "first" })).toString(
            "base64url",
          );

          expect(yield* reason(verify(`${forgedHeader}.${body}.${signature}`))).toBe("signature");
        }

        const changed = Buffer.from(JSON.stringify({ ...claims, repository_id: "evil" })).toString(
          "base64url",
        );

        expect(yield* reason(verify(`${header}.${changed}.${signature}`))).toBe("signature");

        const impostor = yield* Effect.promise(() =>
          new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: "first" })
            .sign(second.privateKey),
        );

        expect(yield* reason(verify(impostor))).toBe("signature");

        for (const value of ["", "garbage", "a.b.c", ".".repeat(20), "x".repeat(16_385)]) {
          expect(yield* reason(verify(value))).toBe("malformed");
        }

        yield* verify(token);
      }),
    );
  });

  test("two independent verifier instances race on one D1-backed replay record", async () => {
    await run(
      Effect.gen(function* () {
        const token = yield* sign();

        const outcomes = yield* Effect.all(
          [
            verify(token).pipe(Effect.result, Effect.provide(Layer.fresh(OidcVerifierLive))),
            verify(token).pipe(Effect.result, Effect.provide(Layer.fresh(OidcVerifierLive))),
          ],
          { concurrency: "unbounded" },
        );

        expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
        const rejected = outcomes.find(Result.isFailure);
        expect(rejected?.failure).toMatchObject({ reason: "replay" });
      }),
    );
  });

  test("cleanup retains replay IDs during skew, then removes them after acceptance ends", async () => {
    await run(
      Effect.gen(function* () {
        const token = yield* sign();
        yield* verify(token);
        yield* TestClock.adjust(300_000);
        expect(yield* pruneOidcReplayIds).toBe(0);
        expect(yield* reason(verify(token))).toBe("replay");
        yield* TestClock.adjust(30_000);
        expect(yield* pruneOidcReplayIds).toBe(1);
        expect(yield* reason(verify(token))).toBe("expired");
      }),
    );
  });
});

describe("JWKS discovery and rotation", () => {
  test("KV hit needs no HTTP and unknown kid refreshes/coalesces once", async () => {
    const network = http();
    network.rotate();
    await run(
      Effect.gen(function* () {
        const cache = yield* JwksCache;
        yield* cache.refresh(issuer, Effect.succeed(firstKeys));
        yield* verify(yield* sign());
        expect(network.urls).toHaveLength(0);

        const tokens = yield* Effect.all([
          sign({ jti: "new-1" }, true),
          sign({ jti: "new-2" }, true),
        ]);

        yield* Effect.all(tokens.map(verify), { concurrency: "unbounded" });
        expect(network.urls).toHaveLength(2);
      }),
      network,
    );
  });

  test("random unknown kids cannot trigger a refresh storm, rotation works after cooldown", async () => {
    const network = http();
    await run(
      Effect.gen(function* () {
        yield* verify(yield* sign());
        network.rotate();
        const rotated = yield* sign({ jti: "rotated" }, true);

        const outcomes = yield* Effect.all(
          Array.from({ length: 20 }, () => reason(verify(rotated))),
          { concurrency: "unbounded" },
        );

        expect(outcomes.every((value) => value === "unknown_kid")).toBe(true);
        expect(network.urls).toHaveLength(2);
        yield* TestClock.adjust(30_000);
        yield* verify(rotated);
        expect(network.urls).toHaveLength(4);
      }),
      network,
    );
  });

  test.each([
    { issuer: "https://evil.example", jwks_uri: `${issuer}/keys` },
    { issuer, jwks_uri: "https://evil.example/keys" },
    { issuer, jwks_uri: `http://token.actions.githubusercontent.com/keys` },
    { issuer, jwks_uri: `https://secret@token.actions.githubusercontent.com/keys` },
    { issuer, jwks_uri: "not a URL" },
  ])("rejects unsafe discovery %#", async (discovery) => {
    const network = http();
    network.discovery(discovery);
    await run(
      Effect.gen(function* () {
        expect(yield* reason(verify(yield* sign()))).toBe("unavailable");
        expect(network.urls).toHaveLength(1);
      }),
      network,
    );
  });

  test("HTTP failures fail closed and are cooled down", async () => {
    const network = http();
    network.status(302);
    await run(
      Effect.gen(function* () {
        const token = yield* sign();
        expect(yield* reason(verify(token))).toBe("unavailable");
        expect(yield* reason(verify(token))).toBe("unavailable");
        expect(network.urls).toHaveLength(1);
        network.status(200);
        yield* TestClock.adjust(30_000);
        yield* verify(token);
      }),
      network,
    );
  });

  test("fetch transport disables redirects and rejects oversized streamed responses", async () => {
    let requests = 0;

    const transport: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        requests++;
        expect(options?.redirect).toBe("manual");
        expect(options?.credentials).toBe("omit");

        return Response.json({ issuer, jwks_uri: `${issuer}/keys`, padding: "x".repeat(65_536) });
      },
      { preconnect: fetch.preconnect },
    );

    const network = {
      ...http(),
      layer: FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    };

    await run(
      Effect.gen(function* () {
        expect(yield* reason(verify(yield* sign()))).toBe("unavailable");
        expect(requests).toBe(1);
      }),
      network,
    );
  });

  test("mutated JWT segments fail without defects or consuming the valid token", async () => {
    await run(
      Effect.gen(function* () {
        const token = yield* sign();

        for (let index = 0; index < token.length; index += 31) {
          if (token[index] === ".") continue;
          const replacement = token[index] === "A" ? "B" : "A";
          const mutated = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
          expect(yield* reason(verify(mutated))).toBeDefined();
        }

        yield* verify(token);
      }),
    );
  });

  test("rejects private and symmetric key sets from HTTP and KV", async () => {
    for (const keys of [
      { keys: [{ ...firstJwk, d: "private" }] },
      { keys: [{ kty: "oct", kid: "first", k: "secret" }] },
      { keys: [] },
    ]) {
      const network = http();
      network.keys(keys);
      await run(
        Effect.gen(function* () {
          expect(yield* reason(verify(yield* sign()))).toBe("unavailable");
        }),
        network,
      );
      await run(
        Effect.gen(function* () {
          yield* (yield* JwksCache).refresh(issuer, Effect.succeed(keys));
          expect(yield* reason(verify(yield* sign()))).toBe("unavailable");
        }),
      );
    }
  });
});
