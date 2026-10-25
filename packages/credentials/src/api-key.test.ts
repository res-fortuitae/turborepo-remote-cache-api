/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun adapter test boundary. */
import { expect, test } from "bun:test";
import { ApiKeyLookup, ApiKeyVerificationError } from "@repo/auth";
import { Effect, Layer, Redacted } from "effect";
import { ApiKeyVerifier, ApiKeyVerifierLive } from "./api-key.ts";

test("API key adapter maps org ownership into the cache principal and preserves failures", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const verifier = yield* ApiKeyVerifier;
      expect(yield* verifier.verify(Redacted.make("tcache_test"))).toEqual({
        subject: "api-key:k",
        org: "o",
        project: "p",
        scope: "read write",
        tokenId: "k",
        issuedAt: 100,
        expiresAt: 200,
      });
      expect((yield* Effect.result(verifier.verify(Redacted.make("invalid"))))._tag).toBe(
        "Failure",
      );
    }).pipe(
      Effect.provide(
        ApiKeyVerifierLive.pipe(
          Layer.provide(
            Layer.succeed(ApiKeyLookup, {
              verify: (key) =>
                key === "tcache_test"
                  ? Effect.succeed({
                      id: "k",
                      orgId: "o",
                      projectId: "p",
                      scope: "read write",
                      issuedAt: 100000,
                      expiresAt: 200000,
                      orgEpoch: 0,
                      projectEpoch: 0,
                    })
                  : Effect.fail(new ApiKeyVerificationError({ cause: "invalid" })),
            }),
          ),
        ),
      ),
    ),
  );
});
