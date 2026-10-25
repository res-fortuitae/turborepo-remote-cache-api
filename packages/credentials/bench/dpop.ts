// Crypto + service overhead only; excludes D1/network and is not a Workers CPU measurement.
import { ReplayGuard } from "@repo/db";
import { Effect, Layer } from "effect";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { DpopVerifier, DpopVerifierLive } from "../src/index.ts";

const pair = await generateKeyPair("ES256");
const jwk = await exportJWK(pair.publicKey);
const layer = DpopVerifierLive.pipe(
  Layer.provide(
    Layer.succeed(ReplayGuard, {
      claim: () => Effect.succeed(true),
      purgeExpired: () => Effect.succeed(0),
    }),
  ),
);
await Effect.runPromise(
  Effect.gen(function* () {
    const verifier = yield* DpopVerifier;
    const proof = awaitSign();
    function awaitSign() {
      return Effect.promise(() =>
        new SignJWT({ htm: "GET", htu: "https://cache.test/v8/artifacts/abc" })
          .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
          .setIssuedAt()
          .setJti(crypto.randomUUID())
          .sign(pair.privateKey),
      );
    }
    const signed = yield* proof;
    const start = performance.now();
    for (let i = 0; i < 1000; i++)
      yield* verifier.verify({
        proof: signed,
        method: "GET",
        url: "https://cache.test/v8/artifacts/abc",
      });
    console.log(
      JSON.stringify({
        requests: 1000,
        meanVerificationMillis: (performance.now() - start) / 1000,
        replayStore: "no-op for isolated crypto benchmark",
      }),
    );
  }).pipe(Effect.provide(layer)),
);
