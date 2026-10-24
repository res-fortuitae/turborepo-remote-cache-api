import { describe, expect, test } from "bun:test";
import { CoordinatorClient } from "@repo/coordinator";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Layer, Result } from "effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { importJWK, SignJWT } from "jose";
import {
  CACHE_TOKEN_TEST_ISSUER,
  CacheTokenConfig,
  CacheTokenConfigLive,
  CacheTokenInvalid,
  type CacheTokenRequest,
  CacheTokenRequestInvalid,
  CacheTokenRevoked,
  CacheTokenSigner,
  CacheTokenSignerLive,
  CacheTokensTest,
  CacheTokenVerifier,
  CacheTokenVerifierLive,
  KeyStore,
  KeyStoreTestControl,
} from "./index.ts";

type Env =
  | CacheTokenSigner
  | CacheTokenVerifier
  | KeyStore
  | KeyStoreTestControl
  | CoordinatorClient
  | CacheTokenConfig;

const run = <A, E>(program: Effect.Effect<A, E, Env | TestClock.TestClock>) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(program.pipe(Effect.provide(Layer.merge(CacheTokensTest, TestClock.layer()))));

const request: CacheTokenRequest = {
  subject: "oidc:github:repo:42:ref:refs/heads/main",
  org: "acme",
  project: "web",
  scope: "read write",
};

const issue = (overrides: Partial<CacheTokenRequest> = {}) =>
  CacheTokenSigner.use((signer) => signer.issue({ ...request, ...overrides }));

const verify = (token: string) => CacheTokenVerifier.use((verifier) => verifier.verify(token));

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isFailure(result) ? result.failure : undefined,
  );

const reason = <E>(error: E) => (error instanceof CacheTokenInvalid ? error.reason : error);

describe("sign and verify", () => {
  test("live config derives issuer and audience from the canonical origin", async () => {
    await run(
      Effect.gen(function* () {
        const issued = yield* issue();

        const payload = JSON.parse(
          Buffer.from(issued.token.split(".")[1]!, "base64url").toString(),
        );

        expect(payload.iss).toBe("https://new.example.com");
        expect(payload.aud).toBe("https://new.example.com");
        expect(yield* verify(issued.token)).toEqual(issued.principal);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.fresh(CacheTokenSignerLive),
            Layer.fresh(CacheTokenVerifierLive),
          ).pipe(
            Layer.provide(CacheTokenConfigLive),
            Layer.provide(Layer.succeed(CanonicalOrigin, "https://new.example.com")),
          ),
        ),
      ),
    );
  });

  test("a fresh token verifies to its principal", async () => {
    await run(
      Effect.gen(function* () {
        yield* TestClock.adjust(1_000_000);
        const issued = yield* issue();
        const principal = yield* verify(issued.token);

        expect(principal).toEqual(issued.principal);
        expect(principal).toMatchObject({ subject: request.subject, org: "acme", project: "web" });
        expect(principal.expiresAt - principal.issuedAt).toBe(3600);
      }),
    );
  });

  test("the header names the kid and claims carry org, prj, scope and epoch", async () => {
    await run(
      Effect.gen(function* () {
        const issued = yield* issue({ scope: "read" });

        const [header, payload] = issued.token
          .split(".")
          .slice(0, 2)
          .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));

        expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: issued.kid });
        expect(payload).toMatchObject({
          iss: CACHE_TOKEN_TEST_ISSUER,
          aud: CACHE_TOKEN_TEST_ISSUER,
          org: "acme",
          prj: "web",
          scope: "read",
          epoch: { org: 0, prj: 0 },
        });
      }),
    );
  });

  test("TTL is lowered by trust policy and capped by instance policy", async () => {
    await run(
      Effect.gen(function* () {
        const lowered = yield* issue({ maxTtlSeconds: 300 });
        expect(lowered.principal.expiresAt - lowered.principal.issuedAt).toBe(300);

        const raised = yield* issue({ maxTtlSeconds: 7200 });
        expect(raised.principal.expiresAt - raised.principal.issuedAt).toBe(3600);

        expect(yield* failure(issue({ maxTtlSeconds: 0 }))).toBeInstanceOf(
          CacheTokenRequestInvalid,
        );
      }),
    );

    await run(
      Effect.gen(function* () {
        const issued = yield* issue();
        expect(issued.principal.expiresAt - issued.principal.issuedAt).toBe(600);
      }).pipe(
        Effect.provide(
          Layer.fresh(CacheTokenSignerLive).pipe(
            Layer.provide(
              Layer.succeed(CacheTokenConfig, {
                issuer: CACHE_TOKEN_TEST_ISSUER,
                maxTtlSeconds: 600,
              }),
            ),
          ),
        ),
      ),
    );
  });
});

describe("rejections", () => {
  test("an expired token is rejected", async () => {
    await run(
      Effect.gen(function* () {
        const issued = yield* issue({ maxTtlSeconds: 60 });
        yield* TestClock.adjust(61_000);
        expect(reason(yield* failure(verify(issued.token)))).toBe("expired");
      }),
    );
  });

  test("wrong issuer or audience is rejected", async () => {
    await run(
      Effect.gen(function* () {
        const set = Redacted.value(yield* KeyStore.use((store) => store.signingKeys));
        const key = set.keys[0]!;
        const privateKey = yield* Effect.promise(() => importJWK(key, "EdDSA"));

        const sign = (iss: string, aud: string) =>
          Effect.promise(() =>
            new SignJWT({ org: "acme", prj: "web", scope: "read", epoch: { org: 0, prj: 0 } })
              .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: key.kid })
              .setIssuer(iss)
              .setAudience(aud)
              .setSubject("user:1")
              .setJti("j")
              .setIssuedAt(0)
              .setNotBefore(0)
              .setExpirationTime(60)
              .sign(privateKey),
          );

        const good = yield* sign(CACHE_TOKEN_TEST_ISSUER, CACHE_TOKEN_TEST_ISSUER);
        expect((yield* verify(good)).subject).toBe("user:1");
        expect(
          reason(yield* failure(verify(yield* sign("https://evil.test", CACHE_TOKEN_TEST_ISSUER)))),
        ).toBe("claims");
        expect(
          reason(yield* failure(verify(yield* sign(CACHE_TOKEN_TEST_ISSUER, "turbo-cache")))),
        ).toBe("claims");
      }),
    );
  });

  test("tampered payloads and garbage are rejected", async () => {
    await run(
      Effect.gen(function* () {
        const { token } = yield* issue();
        const [header, , signature] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ org: "other" })).toString("base64url");

        expect(reason(yield* failure(verify(`${header}.${forged}.${signature}`)))).toBe(
          "signature",
        );
        expect(reason(yield* failure(verify("not-a-jwt")))).toBe("malformed");
      }),
    );
  });

  test("a token signed by another instance's key is an unknown kid", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
    const foreign = await Effect.runPromise(issue().pipe(Effect.provide(CacheTokensTest)));

    await run(
      Effect.gen(function* () {
        expect(reason(yield* failure(verify(foreign.token)))).toBe("unknown_kid");
      }),
    );
  });
});

describe("rotation", () => {
  test("both keys verify during overlap, the retired key stops verifying", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* KeyStoreTestControl;
        const old = yield* issue();
        const nextKid = yield* control.rotate;
        const fresh = yield* issue();

        expect(fresh.kid).toBe(nextKid);
        expect(fresh.kid).not.toBe(old.kid);
        yield* verify(old.token);
        yield* verify(fresh.token);

        const jwks = yield* CacheTokenVerifier.use((verifier) => verifier.jwks);
        expect(jwks.keys.map((key) => key.kid).sort()).toEqual([old.kid, nextKid].sort());
        expect(jwks.keys.every((key) => !("d" in key) && key.alg === "EdDSA")).toBe(true);

        yield* control.retirePrevious;
        expect(reason(yield* failure(verify(old.token)))).toBe("unknown_kid");
        yield* verify(fresh.token);
      }),
    );
  });
});

describe("revocation epochs", () => {
  test("revoking the org rejects outstanding tokens; new tokens verify", async () => {
    await run(
      Effect.gen(function* () {
        const coordinator = yield* CoordinatorClient;
        const old = yield* issue();
        yield* coordinator.revokeAll("org:acme");

        const error = yield* failure(verify(old.token));
        expect(error).toBeInstanceOf(CacheTokenRevoked);
        expect(error instanceof CacheTokenRevoked && error.scope).toBe("org:acme");

        const fresh = yield* issue();
        yield* verify(fresh.token);
      }),
    );
  });

  test("revoking the project rejects its tokens but not other projects'", async () => {
    await run(
      Effect.gen(function* () {
        const coordinator = yield* CoordinatorClient;
        yield* coordinator.revokeAll("org:acme");
        const web = yield* issue();
        const docs = yield* issue({ project: "docs" });
        yield* coordinator.revokeAll("project:web");

        const error = yield* failure(verify(web.token));
        expect(error instanceof CacheTokenRevoked && error.scope).toBe("project:web");
        yield* verify(docs.token);
      }),
    );
  });
});
