import { ReplayGuard, type DatabaseError } from "@repo/db";
import { OidcAudience, matchOidcAudience } from "@repo/deploy-config";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { GITHUB_ACTIONS_ISSUER, IssuerRegistry, type OidcIssuer } from "./issuer-registry.ts";
import { Jwks, JwksCache, JWKS_TTL_SECONDS } from "./jwks-cache.ts";

export const OidcVerifierSettings = Schema.Struct({
  allowedIssuers: Schema.Array(Schema.NonEmptyString),
  maxTokenAgeSeconds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600)),
  clockSkewSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(60),
  ),
});

export class OidcVerifierConfig extends Context.Service<
  OidcVerifierConfig,
  typeof OidcVerifierSettings.Type
>()("@repo/oidc/OidcVerifierConfig") {}

export const OidcVerifierDefaults = Layer.succeed(OidcVerifierConfig, {
  allowedIssuers: [GITHUB_ACTIONS_ISSUER],
  maxTokenAgeSeconds: 600,
  clockSkewSeconds: 30,
});

export class OidcVerificationError extends Schema.TaggedError<OidcVerificationError>()(
  "OidcVerificationError",
  {
    reason: Schema.Literals([
      "malformed",
      "issuer",
      "audience",
      "claims",
      "expired",
      "signature",
      "unknown_kid",
      "replay",
      "unavailable",
    ]),
  },
) {}

export interface VerifiedOidcToken {
  readonly claims: JWTPayload;
  /** Exact matched CI audience, for the trust policy and provenance/audit record. */
  readonly audience: string;
  readonly issuer: string;
  readonly subject: string;
  readonly tokenId: string;
  readonly expiresAt: number;
}

export class OidcVerifier extends Context.Service<
  OidcVerifier,
  {
    /** Consumes the jti only after signature and claim validation succeed. */
    readonly verify: (
      token: string,
    ) => Effect.Effect<VerifiedOidcToken, OidcVerificationError | DatabaseError>;
  }
>()("@repo/oidc/OidcVerifier") {}

const invalid = (reason: OidcVerificationError["reason"]) => new OidcVerificationError({ reason });

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});

const Claims = Schema.Struct({
  iss: Schema.NonEmptyString,
  sub: Schema.NonEmptyString,
  jti: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  aud: Schema.Union([Schema.NonEmptyString, Schema.Array(Schema.NonEmptyString)]),
  iat: Schema.Int,
  nbf: Schema.Int,
  exp: Schema.Int,
});

const Discovery = Schema.Struct({ issuer: Schema.String, jwks_uri: Schema.String });
const decodeClaims = Schema.decodeUnknownEffect(Claims);
const decodeHeader = Schema.decodeUnknownSync(Header);
const decodeDiscovery = Schema.decodeUnknownEffect(Discovery);
const decodeJwks = Schema.decodeUnknownEffect(Jwks);
const decodeConfig = Schema.decodeUnknownEffect(OidcVerifierSettings);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/** One forced network refresh per issuer per 30 seconds, including failed attempts. */
export const OIDC_REFRESH_COOLDOWN_MILLIS = 30_000;

interface KeyState {
  readonly keys: Jwks;
  readonly resolve: ReturnType<typeof createLocalJWKSet>;
  readonly expiresAt: number;
}

export const OidcVerifierLive = Layer.effect(
  OidcVerifier,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const cache = yield* JwksCache;
    const registry = yield* IssuerRegistry;
    const replay = yield* ReplayGuard;
    const audiences = yield* OidcAudience;

    const config = yield* Effect.orDie(decodeConfig(yield* OidcVerifierConfig));

    if (audiences.length === 0)
      return yield* Effect.die(new Error("OIDC audience allowlist must not be empty"));

    const states = new Map<string, KeyState>();
    const attempts = new Map<string, number>();
    const gate = yield* Semaphore.make(1);

    const getJson = Effect.fn("OidcVerifier.getJson")(function* (url: string) {
      // The injected client must not install redirect-following middleware.
      const response = yield* client.get(url);

      if (response.status !== 200) return yield* invalid("unavailable");
      // FetchHttpClient's response.json does not enforce MaxBodySize; bound the stream ourselves.
      const chunks: Uint8Array[] = [];

      const body = yield* Stream.runFoldEffect(
        response.stream,
        () => ({ size: 0, chunks }),
        (body, chunk) => {
          const size = body.size + chunk.byteLength;

          if (size > 64 * 1024) return Effect.fail(invalid("unavailable"));
          body.chunks.push(chunk);

          return Effect.succeed({ size, chunks: body.chunks });
        },
      );

      const bytes = new Uint8Array(body.size);
      let offset = 0;

      for (const chunk of body.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return yield* decodeJson(new TextDecoder().decode(bytes));
    });

    const load = Effect.fn("OidcVerifier.load")(function* (issuer: OidcIssuer) {
      attempts.set(issuer.issuer, yield* Clock.currentTimeMillis);

      const discovery = yield* getJson(`${issuer.issuer}/.well-known/openid-configuration`).pipe(
        Effect.flatMap(decodeDiscovery),
      );

      const uri = yield* Effect.try(() => new URL(discovery.jwks_uri));

      if (
        discovery.issuer !== issuer.issuer ||
        uri.protocol !== "https:" ||
        uri.username ||
        uri.password ||
        uri.hash ||
        !issuer.jwksOrigins.includes(uri.origin)
      ) {
        return yield* invalid("unavailable");
      }

      const keys = yield* getJson(uri.href).pipe(Effect.flatMap(decodeJwks));

      if (
        keys.keys.length === 0 ||
        keys.keys.length > 100 ||
        keys.keys.some((key) => key.kty === "oct" || "d" in key)
      ) {
        return yield* invalid("unavailable");
      }

      return keys;
    });

    const remoteKeys = (issuer: OidcIssuer) =>
      load(issuer).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
        }),
        Effect.timeout("5 seconds"),
        Effect.mapError(() => invalid("unavailable")),
      );

    const keysFor = (issuer: OidcIssuer, refresh: boolean) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = states.get(issuer.issuer);

          if (!refresh && current !== undefined && current.expiresAt > now) return current;

          if (
            now - (attempts.get(issuer.issuer) ?? Number.NEGATIVE_INFINITY) <
            OIDC_REFRESH_COOLDOWN_MILLIS
          ) {
            if (current !== undefined && current.expiresAt > now) return current;

            return yield* invalid("unavailable");
          }

          const keys = yield* refresh
            ? cache.refresh(issuer.issuer, remoteKeys(issuer))
            : cache.get(issuer.issuer, remoteKeys(issuer));

          // Apply the same public-key restrictions to values read from KV.
          if (
            keys.keys.length === 0 ||
            keys.keys.length > 100 ||
            keys.keys.some((key) => key.kty === "oct" || "d" in key)
          ) {
            return yield* invalid("unavailable");
          }

          const resolve = yield* Effect.try({
            try: () => createLocalJWKSet({ keys: keys.keys.map((key) => ({ ...key })) }),
            catch: () => invalid("unavailable"),
          });

          const state = { keys, resolve, expiresAt: now + JWKS_TTL_SECONDS * 1000 };
          states.set(issuer.issuer, state);

          return state;
        }),
      );

    return {
      verify: Effect.fn("OidcVerifier.verify")(function* (token: string) {
        if (token.length > 16_384 || token.length === 0) return yield* invalid("malformed");

        const { header, untrusted } = yield* Effect.try({
          try: () => ({
            header: decodeHeader(decodeProtectedHeader(token)),
            untrusted: decodeJwt(token),
          }),
          catch: () => invalid("malformed"),
        });

        if (untrusted.iss === undefined || !config.allowedIssuers.includes(untrusted.iss))
          return yield* invalid("issuer");
        const found = registry.find(untrusted.iss);

        if (Option.isNone(found)) return yield* invalid("issuer");
        const issuer = found.value;

        if (!issuer.algorithms.some((alg) => alg === header.alg))
          return yield* invalid("signature");

        let state = yield* keysFor(issuer, false);

        if (!state.keys.keys.some((key) => key.kid === header.kid))
          state = yield* keysFor(issuer, true);

        if (!state.keys.keys.some((key) => key.kid === header.kid))
          return yield* invalid("unknown_kid");

        const now = yield* Clock.currentTimeMillis;

        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, state.resolve, {
              issuer: issuer.issuer,
              audience: [...audiences],
              algorithms: [...issuer.algorithms],
              requiredClaims: ["sub", "jti", "iat", "nbf", "exp"],
              maxTokenAge: config.maxTokenAgeSeconds,
              clockTolerance: config.clockSkewSeconds,
              currentDate: new Date(now),
            }),
          catch: (error) =>
            invalid(
              error instanceof errors.JWTExpired
                ? "expired"
                : error instanceof errors.JWTClaimValidationFailed
                  ? error.claim === "aud"
                    ? "audience"
                    : "claims"
                  : "signature",
            ),
        });

        const claims = yield* decodeClaims(payload).pipe(Effect.mapError(() => invalid("claims")));

        if (
          claims.exp <= claims.iat ||
          claims.nbf >= claims.exp ||
          claims.exp - claims.iat > config.maxTokenAgeSeconds
        )
          return yield* invalid("claims");
        const audience = matchOidcAudience(audiences, claims.aud);

        if (Option.isNone(audience)) return yield* invalid("audience");
        // Keep the row throughout the skew window, after which jose rejects this token.
        const acceptedUntil = (claims.exp + config.clockSkewSeconds) * 1000;

        if (!(yield* replay.claim(claims.iss, claims.jti, acceptedUntil, now)))
          return yield* invalid("replay");

        return {
          claims: payload,
          audience: audience.value,
          issuer: claims.iss,
          subject: claims.sub,
          tokenId: claims.jti,
          expiresAt: claims.exp * 1000,
        };
      }),
    };
  }),
);

/** Use in the host's cron to delete replay IDs after the entire acceptance window. */
export const pruneOidcReplayIds = Effect.gen(function* () {
  const replay = yield* ReplayGuard;

  return yield* replay.purgeExpired(yield* Clock.currentTimeMillis);
});
