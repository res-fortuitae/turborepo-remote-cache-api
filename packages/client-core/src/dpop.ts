import { Clock, Context, Effect, Layer, Redacted } from "effect";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ClientAuthError } from "./config.ts";

const failed = () =>
  new ClientAuthError({
    reason: "dpop",
    message: "Could not create a DPoP proof. Check Web Crypto availability and request URL.",
  });

export interface DpopRequest {
  readonly url: string;
  readonly method: string;
  readonly accessToken?: Redacted.Redacted<string>;
  readonly nonce?: string;
}

const make = Effect.gen(function* () {
  const keys = yield* Effect.tryPromise({ try: () => generateKeyPair("ES256"), catch: failed });
  const jwk = yield* Effect.tryPromise({ try: () => exportJWK(keys.publicKey), catch: failed });

  const thumbprint = yield* Effect.tryPromise({
    try: () => calculateJwkThumbprint(jwk),
    catch: failed,
  });

  return {
    thumbprint,
    proof: Effect.fn("DpopSigner.proof")(function* (input: DpopRequest) {
      const url = yield* Effect.try({ try: () => new URL(input.url), catch: failed });

      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !/^[A-Za-z]+$/.test(input.method)
      )
        return yield* failed();
      url.search = "";
      url.hash = "";
      const accessToken = input.accessToken;

      const ath =
        accessToken === undefined
          ? undefined
          : yield* Effect.tryPromise({
              try: async () => {
                const digest = await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(Redacted.value(accessToken)),
                );

                return btoa(String.fromCharCode(...new Uint8Array(digest)))
                  .replaceAll("+", "-")
                  .replaceAll("/", "_")
                  .replace(/=+$/, "");
              },
              catch: failed,
            });

      const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      return Redacted.make(
        yield* Effect.tryPromise({
          try: () =>
            new SignJWT({
              htm: input.method.toUpperCase(),
              htu: url.href,
              ath,
              nonce: input.nonce,
            })
              .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
              .setJti(crypto.randomUUID())
              .setIssuedAt(iat)
              .sign(keys.privateKey),
          catch: failed,
        }),
      );
    }),
  };
});

export class DpopSigner extends Context.Service<DpopSigner, Effect.Success<typeof make>>()(
  "@repo/client-core/DpopSigner",
) {}

export const DpopSignerLive = Layer.effect(DpopSigner, make);
