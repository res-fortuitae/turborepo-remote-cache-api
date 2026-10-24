import { CoordinatorClient, CoordinatorClientTest, type CoordinatorError } from "@repo/coordinator";
import { CanonicalOrigin } from "@repo/deploy-config";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  type CryptoKey,
  decodeProtectedHeader,
  errors,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";
import {
  KeyStore,
  type KeyStoreError,
  KeyStoreTest,
  type KeyStoreTestControl,
  type OkpJwk,
  type SigningKeySet,
} from "./key-store.ts";
import { CacheScope, Principal } from "./principal.ts";

export const CACHE_TOKEN_ALGORITHM = "EdDSA";
/** The issue-time default; instance policy and trust policies only lower it. */

export const DEFAULT_CACHE_TOKEN_TTL_SECONDS = 60 * 60;

/** Decoded by the app from deployment config and supplied with `Layer.succeed`. */
export class CacheTokenConfig extends Context.Service<
  CacheTokenConfig,
  {
    /** Our canonical origin; both the `iss` and `aud` claims (STV-494). */
    readonly issuer: string;
    /** Instance policy ceiling on token lifetime. */
    readonly maxTtlSeconds: number;
  }
>()("@repo/credentials/CacheTokenConfig") {}

/** The instance policy may provide a stricter ceiling instead of this default. */
export const CacheTokenConfigLive = Layer.effect(
  CacheTokenConfig,
  Effect.map(CanonicalOrigin, (issuer) => ({
    issuer,
    maxTtlSeconds: DEFAULT_CACHE_TOKEN_TTL_SECONDS,
  })),
);

/** Revocation epochs the token was issued under, one per Coordinator scope. */
export const CacheTokenEpoch = Schema.Struct({ org: Schema.Int, prj: Schema.Int });

export const CacheTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  sub: Schema.NonEmptyString,
  org: Schema.NonEmptyString,
  prj: Schema.NonEmptyString,
  scope: CacheScope,
  epoch: CacheTokenEpoch,
  jti: Schema.NonEmptyString,
  iat: Schema.Int,
  nbf: Schema.Int,
  exp: Schema.Int,
});

export type CacheTokenClaims = typeof CacheTokenClaims.Type;

export const CacheTokenRequest = Schema.Struct({
  subject: Schema.NonEmptyString,
  org: Schema.NonEmptyString,
  project: Schema.NonEmptyString,
  scope: CacheScope,
  /** Lower bound from the matching trust policy, if any. */
  maxTtlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type CacheTokenRequest = typeof CacheTokenRequest.Type;

export interface IssuedCacheToken {
  readonly token: string;
  readonly principal: Principal;
  readonly kid: string;
}

/** A published JSON Web Key Set: public halves only. */
export interface CacheTokenJwks {
  readonly keys: ReadonlyArray<{
    readonly kty: "OKP";
    readonly crv: "Ed25519";
    readonly kid: string;
    readonly x: string;
    readonly alg: typeof CACHE_TOKEN_ALGORITHM;
    readonly use: "sig";
  }>;
}

export class CacheTokenInvalid extends Schema.TaggedError<CacheTokenInvalid>()(
  "CacheTokenInvalid",
  {
    reason: Schema.Literals(["malformed", "unknown_kid", "signature", "expired", "claims"]),
    message: Schema.String,
  },
) {}

export class CacheTokenRevoked extends Schema.TaggedError<CacheTokenRevoked>()(
  "CacheTokenRevoked",
  { scope: Schema.String },
) {}

export class CacheTokenRequestInvalid extends Schema.TaggedError<CacheTokenRequestInvalid>()(
  "CacheTokenRequestInvalid",
  { message: Schema.String },
) {}

export interface CacheTokenSignerService {
  readonly issue: (
    request: CacheTokenRequest,
  ) => Effect.Effect<IssuedCacheToken, CacheTokenRequestInvalid | KeyStoreError | CoordinatorError>;
}

export class CacheTokenSigner extends Context.Service<CacheTokenSigner, CacheTokenSignerService>()(
  "@repo/credentials/CacheTokenSigner",
) {}

export interface CacheTokenVerifierService {
  /** Signature, claims and revocation epochs; nothing else is stored. */
  readonly verify: (
    token: string,
  ) => Effect.Effect<
    Principal,
    CacheTokenInvalid | CacheTokenRevoked | KeyStoreError | CoordinatorError
  >;
  /** The `/.well-known/jwks.json` document: every active key, so both rotation keys verify. */
  readonly jwks: Effect.Effect<CacheTokenJwks, KeyStoreError>;
}

export class CacheTokenVerifier extends Context.Service<
  CacheTokenVerifier,
  CacheTokenVerifierService
>()("@repo/credentials/CacheTokenVerifier") {}

const orgScope = (org: string) => `org:${org}`;
const projectScope = (project: string) => `project:${project}`;

const publicJwk = ({ kty, crv, kid, x }: OkpJwk) => ({ kty, crv, kid, x });

/** Imported keys are immutable, so cache them per isolate by `kid` and key material. */
const makeKeyImporter = () => {
  const imported = new Map<string, CryptoKey>();

  return (jwk: JWK & { readonly kid: string }) => {
    const cacheKey = `${jwk.kid}:${jwk.x}:${jwk.d === undefined ? "public" : "private"}`;
    const cached = imported.get(cacheKey);

    if (cached !== undefined) return Effect.succeed(cached);

    return Effect.promise(() => importJWK(jwk, CACHE_TOKEN_ALGORITHM)).pipe(
      Effect.map((key) => {
        // SAFETY: importJWK returns a CryptoKey for asymmetric JWKs.
        const cryptoKey = key as CryptoKey;
        imported.set(cacheKey, cryptoKey);

        return cryptoKey;
      }),
    );
  };
};

const currentKey = (set: SigningKeySet) => {
  const key = set.keys.find((candidate) => candidate.kid === set.current);

  // KeyStore decoding guarantees `current` names a key.
  return key === undefined
    ? Effect.die(new Error("current signing key missing"))
    : Effect.succeed(key);
};

const decodeRequest = Schema.decodeUnknownEffect(CacheTokenRequest);

export const CacheTokenSignerLive: Layer.Layer<
  CacheTokenSigner,
  never,
  KeyStore | CacheTokenConfig | CoordinatorClient
> = Layer.effect(
  CacheTokenSigner,
  Effect.gen(function* () {
    const keyStore = yield* KeyStore;
    const config = yield* CacheTokenConfig;
    const coordinator = yield* CoordinatorClient;
    const importKey = makeKeyImporter();

    return {
      issue: Effect.fn("CacheTokenSigner.issue")(function* (input: CacheTokenRequest) {
        const request = yield* Effect.mapError(
          decodeRequest(input),
          (error) => new CacheTokenRequestInvalid({ message: error.message }),
        );

        const ttl = Math.min(
          DEFAULT_CACHE_TOKEN_TTL_SECONDS,
          config.maxTtlSeconds,
          request.maxTtlSeconds ?? Number.POSITIVE_INFINITY,
        );

        if (!(ttl > 0)) {
          return yield* new CacheTokenRequestInvalid({
            message: "token lifetime must be positive",
          });
        }

        const [org, prj] = yield* Effect.all(
          [
            coordinator.revocationEpoch(orgScope(request.org)),
            coordinator.revocationEpoch(projectScope(request.project)),
          ],
          { concurrency: 2 },
        );

        const key = yield* currentKey(Redacted.value(yield* keyStore.signingKeys));
        const privateKey = yield* importKey(key);
        const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const jti = crypto.randomUUID();
        const exp = iat + Math.floor(ttl);

        const token = yield* Effect.promise(() =>
          new SignJWT({
            org: request.org,
            prj: request.project,
            scope: request.scope,
            epoch: { org, prj },
          })
            .setProtectedHeader({ alg: CACHE_TOKEN_ALGORITHM, typ: "JWT", kid: key.kid })
            .setIssuer(config.issuer)
            .setAudience(config.issuer)
            .setSubject(request.subject)
            .setJti(jti)
            .setIssuedAt(iat)
            .setNotBefore(iat)
            .setExpirationTime(exp)
            .sign(privateKey),
        );

        return {
          token,
          kid: key.kid,
          principal: {
            subject: request.subject,
            org: request.org,
            project: request.project,
            scope: request.scope,
            tokenId: jti,
            issuedAt: iat,
            expiresAt: exp,
          },
        };
      }),
    } satisfies CacheTokenSignerService;
  }),
);

const invalid = (reason: CacheTokenInvalid["reason"], message: string) =>
  new CacheTokenInvalid({ reason, message });

const fromJoseError = (cause: unknown) => {
  if (cause instanceof errors.JWTExpired) return invalid("expired", cause.message);

  if (cause instanceof errors.JWTClaimValidationFailed) return invalid("claims", cause.message);

  if (cause instanceof errors.JWSSignatureVerificationFailed) {
    return invalid("signature", cause.message);
  }

  return invalid("malformed", cause instanceof Error ? cause.message : "invalid token");
};

const decodeHeader = Schema.decodeUnknownEffect(
  Schema.Struct({ alg: Schema.Literal(CACHE_TOKEN_ALGORITHM), kid: Schema.NonEmptyString }),
);

const decodeClaims = Schema.decodeUnknownEffect(CacheTokenClaims);

export const CacheTokenVerifierLive: Layer.Layer<
  CacheTokenVerifier,
  never,
  KeyStore | CacheTokenConfig | CoordinatorClient
> = Layer.effect(
  CacheTokenVerifier,
  Effect.gen(function* () {
    const keyStore = yield* KeyStore;
    const config = yield* CacheTokenConfig;
    const coordinator = yield* CoordinatorClient;
    const importKey = makeKeyImporter();

    const findKey = Effect.fn("CacheTokenVerifier.findKey")(function* (token: string) {
      const header = yield* Effect.try({
        try: () => decodeProtectedHeader(token),
        catch: () => invalid("malformed", "token header is not a JWS header"),
      });

      const { kid } = yield* Effect.mapError(decodeHeader(header), () =>
        invalid("malformed", "token must be EdDSA-signed and name a kid"),
      );

      const set = Redacted.value(yield* keyStore.signingKeys);
      const key = Option.fromNullishOr(set.keys.find((candidate) => candidate.kid === kid));

      if (Option.isNone(key)) return yield* invalid("unknown_kid", `unknown kid ${kid}`);

      return yield* importKey(publicJwk(key.value));
    });

    const revokedIn = (scope: string, issuedEpoch: number) =>
      Effect.map(coordinator.isRevoked(scope, issuedEpoch), (revoked) =>
        revoked ? Option.some(scope) : Option.none(),
      );

    return {
      verify: Effect.fn("CacheTokenVerifier.verify")(function* (token: string) {
        const key = yield* findKey(token);
        const now = yield* Clock.currentTimeMillis;

        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, key, {
              issuer: config.issuer,
              audience: config.issuer,
              algorithms: [CACHE_TOKEN_ALGORITHM],
              typ: "JWT",
              currentDate: new Date(now),
              requiredClaims: ["sub", "jti", "iat", "nbf", "exp"],
            }),
          catch: fromJoseError,
        });

        const claims = yield* Effect.mapError(decodeClaims(payload), (error) =>
          invalid("claims", error.message),
        );

        const revoked = yield* Effect.all(
          [
            revokedIn(orgScope(claims.org), claims.epoch.org),
            revokedIn(projectScope(claims.prj), claims.epoch.prj),
          ],
          { concurrency: 2 },
        );

        for (const scope of revoked) {
          if (Option.isSome(scope)) return yield* new CacheTokenRevoked({ scope: scope.value });
        }

        return {
          subject: claims.sub,
          org: claims.org,
          project: claims.prj,
          scope: claims.scope,
          tokenId: claims.jti,
          issuedAt: claims.iat,
          expiresAt: claims.exp,
        } satisfies Principal;
      }),
      jwks: Effect.map(keyStore.signingKeys, (set) => ({
        keys: Redacted.value(set).keys.map((key) => ({
          ...publicJwk(key),
          alg: CACHE_TOKEN_ALGORITHM,
          use: "sig" as const,
        })),
      })),
    } satisfies CacheTokenVerifierService;
  }),
);

export const CACHE_TOKEN_TEST_ISSUER = "https://cache.test";

/**
 * Signer and verifier over in-memory generated keys and in-memory Coordinator
 * epochs, fresh per build. `KeyStoreTestControl` and `CoordinatorClient` stay
 * exposed so tests can rotate keys and revoke scopes.
 */
export const CacheTokensTest: Layer.Layer<
  | CacheTokenSigner
  | CacheTokenVerifier
  | KeyStore
  | KeyStoreTestControl
  | CoordinatorClient
  | CacheTokenConfig
> = Layer.mergeAll(CacheTokenSignerLive, CacheTokenVerifierLive).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      KeyStoreTest,
      CoordinatorClientTest,
      Layer.succeed(CacheTokenConfig, {
        issuer: CACHE_TOKEN_TEST_ISSUER,
        maxTtlSeconds: DEFAULT_CACHE_TOKEN_TTL_SECONDS,
      }),
    ),
  ),
);
