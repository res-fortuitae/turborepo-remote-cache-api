/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes the resolver at the test boundary. */
import { expect, test } from "bun:test";
import { Effect, Layer, Redacted, Result } from "effect";
import { CoordinatorClient } from "@repo/coordinator";
import {
  ApiKeyVerifierTest,
  CacheTokensTest,
  CacheTokenSigner,
  CredentialResolver,
  CredentialResolverLive,
  LegacyCredentialConfig,
} from "./index.ts";

const principal = {
  subject: "api-key:k",
  org: "o",
  project: "p",
  scope: "read" as const,
  tokenId: "k",
  issuedAt: 1,
  expiresAt: 2,
};

const dependencies = Layer.mergeAll(
  CacheTokensTest,
  ApiKeyVerifierTest([{ key: Redacted.make("tcache_fixture"), principal }]),
);

const layer = CredentialResolverLive.pipe(Layer.provideMerge(dependencies));

test("resolver verifies credential types, returns tenant/scopes/identity and rejects malformed or revoked credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolver = yield* CredentialResolver;
      const signer = yield* CacheTokenSigner;

      const jwt = (yield* signer.issue({
        subject: "ci",
        org: "o",
        project: "p",
        scope: "read write",
      })).token;

      const resolved = yield* resolver.resolve(Redacted.make(`Bearer ${jwt}`));
      expect(resolved).toMatchObject({
        orgId: "o",
        projectId: "p",
        scopes: ["read", "write"],
        credentialType: "cacheJwt",
        subject: "ci",
      });
      expect(resolved.credentialId).toBe(resolved.principal.tokenId);
      expect(yield* resolver.resolve(Redacted.make("bearer tcache_fixture"))).toMatchObject({
        credentialType: "apiKey",
        credentialId: "k",
        scopes: ["read"],
        subject: "api-key:k",
      });

      for (const header of [
        "",
        "Basic tcache_fixture",
        "Bearer",
        "Bearer legacy",
        "Bearer tcache_missing",
        "Bearer a.b.c",
        "Bearer tcache_fixture extra",
        "Bearer tcache_fixture,other",
        "Bearer  tcache_fixture",
        `Bearer ${jwt.slice(0, -5)}xxxxx`,
      ]) {
        const result = yield* Effect.result(resolver.resolve(Redacted.make(header)));
        expect(Result.isFailure(result) && result.failure._tag).toBe("CredentialInvalid");
        expect(JSON.stringify(result)).not.toContain("tcache_fixture");
      }

      const coordinator = yield* CoordinatorClient;
      yield* coordinator.revokeAll("project:p");
      expect(
        Result.isFailure(yield* Effect.result(resolver.resolve(Redacted.make(`Bearer ${jwt}`)))),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  ));

test("legacy mode needs an explicit enabled flag; known credential types never fall back", async () => {
  for (const enabled of [false, true]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* CredentialResolver;

        const result = yield* Effect.result(
          resolver.resolve(Redacted.make("Bearer migration-secret")),
        );

        expect(Result.isSuccess(result)).toBe(enabled);

        if (Result.isSuccess(result)) expect(result.success.credentialType).toBe("legacy");
        expect(
          Result.isFailure(
            yield* Effect.result(resolver.resolve(Redacted.make("Bearer migration-secrex"))),
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(
          CredentialResolverLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                dependencies,
                Layer.succeed(LegacyCredentialConfig, {
                  enabled,
                  token: Redacted.make("migration-secret"),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  for (const token of ["a.b.c", "tcache_missing"]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* CredentialResolver;
        expect(
          Result.isFailure(
            yield* Effect.result(resolver.resolve(Redacted.make(`Bearer ${token}`))),
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(
          CredentialResolverLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                dependencies,
                Layer.succeed(LegacyCredentialConfig, {
                  enabled: true,
                  token: Redacted.make(token),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
});
