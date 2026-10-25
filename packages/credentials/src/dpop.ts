import { ReplayGuard } from "@repo/db";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from "jose";

export class DpopInvalid extends Schema.TaggedError<DpopInvalid>()("DpopInvalid", {
  reason: Schema.Literals(["malformed", "signature", "claims", "binding", "replay", "unavailable"]),
}) {}

export interface DpopVerification {
  readonly proof: string;
  readonly method: string;
  readonly url: string;
  readonly thumbprint?: string;
  readonly accessToken?: Redacted.Redacted<string>;
}

const PublicKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  y: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
const Header = Schema.Struct({
  typ: Schema.Literal("dpop+jwt"),
  alg: Schema.Literal("ES256"),
  jwk: PublicKey,
});
const Claims = Schema.Struct({
  jti: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  iat: Schema.Int,
  htm: Schema.NonEmptyString,
  htu: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  ath: Schema.optional(Schema.String),
});
const decodeHeader = Schema.decodeUnknownEffect(Header);
const decodeClaims = Schema.decodeUnknownEffect(Claims);
const invalid = (reason: DpopInvalid["reason"]) => new DpopInvalid({ reason });

const make = Effect.gen(function* () {
  const replay = yield* ReplayGuard;

  return {
    verify: Effect.fn("DpopVerifier.verify")(function* (input: DpopVerification) {
      if (input.proof.length > 8192 || input.proof.includes(","))
        return yield* invalid("malformed");
      const raw = yield* Effect.try({
        try: () => decodeProtectedHeader(input.proof),
        catch: () => invalid("malformed"),
      });

      if (
        raw.jwk &&
        ["d", "k", "p", "q", "dp", "dq", "qi", "oth"].some((name) => Object.hasOwn(raw.jwk!, name))
      )
        return yield* invalid("malformed");
      const header = yield* decodeHeader(raw).pipe(Effect.mapError(() => invalid("malformed")));
      const key = yield* Effect.tryPromise({
        try: () => importJWK(header.jwk, "ES256"),
        catch: () => invalid("signature"),
      });
      const now = yield* Clock.currentTimeMillis;
      const result = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(input.proof, key, {
            algorithms: ["ES256"],
            typ: "dpop+jwt",
            currentDate: new Date(now),
            requiredClaims: ["jti", "iat", "htm", "htu"],
          }),
        catch: () => invalid("signature"),
      });
      const claims = yield* decodeClaims(result.payload).pipe(
        Effect.mapError(() => invalid("claims")),
      );
      const target = yield* Effect.try({
        try: () => new URL(input.url),
        catch: () => invalid("claims"),
      });
      target.search = "";
      target.hash = "";

      if (
        claims.htm !== input.method.toUpperCase() ||
        claims.htu !== target.href ||
        claims.iat * 1000 < now - 30_000 ||
        claims.iat * 1000 > now + 5000
      )
        return yield* invalid("claims");
      const thumbprint = yield* Effect.tryPromise({
        try: () => calculateJwkThumbprint(header.jwk),
        catch: () => invalid("binding"),
      });

      if (input.thumbprint !== undefined && input.thumbprint !== thumbprint)
        return yield* invalid("binding");
      const accessToken = input.accessToken;

      if (accessToken !== undefined) {
        const hash = yield* Effect.tryPromise({
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
          catch: () => invalid("binding"),
        });

        if (claims.ath !== hash) return yield* invalid("binding");
      } else if (claims.ath !== undefined) return yield* invalid("binding");
      const accepted = yield* replay
        .claim(`dpop:${thumbprint}`, claims.jti, (claims.iat + 36) * 1000, now)
        .pipe(Effect.mapError(() => invalid("unavailable")));

      if (!accepted) return yield* invalid("replay");

      return thumbprint;
    }),
  };
});

export class DpopVerifier extends Context.Service<DpopVerifier, Effect.Success<typeof make>>()(
  "@repo/credentials/DpopVerifier",
) {}

export const DpopVerifierLive = Layer.effect(DpopVerifier, make);
