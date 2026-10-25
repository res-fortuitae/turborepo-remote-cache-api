/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun crypto/DB test boundary. */
import { expect, test } from "bun:test";
import { ReplayGuardLive } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Clock, Effect, Layer, Redacted, Result } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { DpopVerifier, DpopVerifierLive, DpopInvalid } from "./index.ts";

const pair = await generateKeyPair("ES256");
const jwk = await exportJWK(pair.publicKey);
const thumbprint = await calculateJwkThumbprint(jwk);
const url = "https://cache.test/v8/artifacts/abc";
const token = "cache-token";
const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const ath = btoa(String.fromCharCode(...hash))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");
const proof = (
  claims: Record<string, unknown> = {},
  key = pair.privateKey,
  header = { typ: "dpop+jwt", alg: "ES256", jwk },
) =>
  Effect.promise(() =>
    new SignJWT({ htm: "GET", htu: url, iat: 1000, jti: crypto.randomUUID(), ath, ...claims })
      .setProtectedHeader(header)
      .sign(key),
  );
const run = (task: Effect.Effect<void, unknown, DpopVerifier | TestClock.TestClock>) =>
  Effect.runPromise(
    task.pipe(
      Effect.provide(
        DpopVerifierLive.pipe(
          Layer.provide(ReplayGuardLive),
          Layer.provide(DatabaseTest),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );
const reason = <A>(task: Effect.Effect<A, DpopInvalid>) =>
  Effect.map(Effect.result(task), (result) =>
    Result.isFailure(result) ? result.failure.reason : undefined,
  );

test("DPoP verifies token hash and key; atomic replay permits one concurrent request", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(1_000_000);
      const verifier = yield* DpopVerifier;
      const signed = yield* proof();
      const input = {
        proof: signed,
        url: url + "?teamId=org",
        method: "GET",
        thumbprint,
        accessToken: Redacted.make(token),
      };
      const results = yield* Effect.all(
        [reason(verifier.verify(input)), reason(verifier.verify(input))],
        { concurrency: 2 },
      );
      expect(results.filter((value) => value === undefined)).toHaveLength(1);
      expect(results).toContain("replay");
      expect(
        yield* reason(
          verifier.verify({
            ...input,
            proof: yield* proof(),
            accessToken: Redacted.make("stolen-other-token"),
          }),
        ),
      ).toBe("binding");
      expect(
        yield* reason(
          verifier.verify({ ...input, proof: yield* proof(), thumbprint: "wrong-key" }),
        ),
      ).toBe("binding");
    }),
  ));

test("DPoP rejects stale/future proofs, URL/method changes, wrong signatures and private keys", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(1_000_000);
      const verifier = yield* DpopVerifier;
      const input = { url, method: "GET", thumbprint, accessToken: Redacted.make(token) };

      for (const claims of [
        { iat: 969 },
        { iat: 1006 },
        { htm: "PUT" },
        { htu: url + "?x=1" },
        { htu: "https://attacker.test/v8/artifacts/abc" },
        { ath: undefined },
        { jti: "" },
      ]) {
        expect(
          yield* reason(verifier.verify({ ...input, proof: yield* proof(claims) })),
        ).toBeDefined();
      }

      const wrong = yield* Effect.promise(() => generateKeyPair("ES256"));
      expect(
        yield* reason(verifier.verify({ ...input, proof: yield* proof({}, wrong.privateKey) })),
      ).toBe("signature");
      expect(
        yield* reason(
          verifier.verify({
            ...input,
            proof: yield* proof({}, pair.privateKey, {
              typ: "dpop+jwt",
              alg: "ES256",
              jwk: { ...jwk, d: "private" },
            }),
          }),
        ),
      ).toBe("malformed");
      expect(yield* reason(verifier.verify({ ...input, proof: "x".repeat(8193) }))).toBe(
        "malformed",
      );
      expect(
        yield* reason(verifier.verify({ ...input, proof: yield* proof(), accessToken: undefined })),
      ).toBe("binding");
      expect(
        yield* verifier.verify({ url, method: "GET", proof: yield* proof({ ath: undefined }) }),
      ).toBe(thumbprint);
    }),
  ));
