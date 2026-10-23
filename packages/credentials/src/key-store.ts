import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { exportJWK, generateKeyPair } from "jose";

/** An Ed25519 key in JWK form. `d` is present only on private keys. */
export const OkpJwk = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  kid: Schema.NonEmptyString,
  x: Schema.NonEmptyString,
  d: Schema.optional(Schema.NonEmptyString),
});

export type OkpJwk = typeof OkpJwk.Type;

/**
 * The signing key secret: every active private key and the `kid` that signs.
 * Rotation publishes a new key first, switches `current` once caches have it,
 * and drops the old key after the longest token lifetime, so at most two
 * keys are active at a time.
 */
export const SigningKeySet = Schema.Struct({
  current: Schema.NonEmptyString,
  keys: Schema.Array(OkpJwk).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
}).check(
  Schema.makeFilter((set) =>
    set.keys.every((key) => key.d !== undefined) && set.keys.some((key) => key.kid === set.current)
      ? undefined
      : "every key must be private and `current` must name one of them",
  ),
);

export type SigningKeySet = typeof SigningKeySet.Type;

export class KeyStoreError extends Schema.TaggedError<KeyStoreError>()("KeyStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface KeyStoreService {
  /** The active keys. Private material stays redacted outside the signer. */
  readonly signingKeys: Effect.Effect<Redacted.Redacted<SigningKeySet>, KeyStoreError>;
}

export class KeyStore extends Context.Service<KeyStore, KeyStoreService>()(
  "@repo/credentials/KeyStore",
) {}

/** The Secrets Store binding holding a `SigningKeySet` as JSON, wrapped by the Worker host. */
export class SigningKeySecret extends Context.Service<
  SigningKeySecret,
  { readonly get: () => Promise<string> }
>()("@repo/credentials/SigningKeySecret") {}

const decodeKeySet = Schema.decodeUnknownEffect(Schema.fromJsonString(SigningKeySet));

/**
 * Reads the secret on every call: Secrets Store reads are cheap, and a
 * rotation then takes effect without redeploying.
 */
export const KeyStoreLive: Layer.Layer<KeyStore, never, SigningKeySecret> = Layer.effect(
  KeyStore,
  Effect.gen(function* () {
    const secret = yield* SigningKeySecret;

    return {
      signingKeys: Effect.tryPromise({
        try: () => secret.get(),
        catch: (cause) => new KeyStoreError({ message: "signing key secret unavailable", cause }),
      }).pipe(
        Effect.flatMap((json) =>
          Effect.mapError(
            decodeKeySet(json),
            (cause) => new KeyStoreError({ message: "signing key secret is malformed", cause }),
          ),
        ),
        Effect.map(Redacted.make),
      ),
    } satisfies KeyStoreService;
  }),
);

const decodeOkpJwk = Schema.decodeUnknownSync(OkpJwk);

const generateKey = Effect.fn("KeyStoreTest.generateKey")(function* () {
  const kid = crypto.randomUUID();

  const { privateKey } = yield* Effect.promise(() =>
    generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }),
  );

  const jwk = yield* Effect.promise(() => exportJWK(privateKey));

  return decodeOkpJwk({ ...jwk, kid });
});

export interface KeyStoreTestControlService {
  /**
   * Overlap rotation in one step: adds a new key, makes it current and keeps
   * only the previous current key alongside it. Returns the new `kid`.
   */
  readonly rotate: Effect.Effect<string>;
  /** Drops every key except the current one, ending the overlap window. */
  readonly retirePrevious: Effect.Effect<void>;
}

export class KeyStoreTestControl extends Context.Service<
  KeyStoreTestControl,
  KeyStoreTestControlService
>()("@repo/credentials/KeyStoreTestControl") {}

/** In-memory generated keys, fresh per layer build. */
export const KeyStoreTest: Layer.Layer<KeyStore | KeyStoreTestControl> = Layer.effectContext(
  Effect.gen(function* () {
    const first = yield* generateKey();
    let set: SigningKeySet = { current: first.kid, keys: [first] };

    const control: KeyStoreTestControlService = {
      rotate: Effect.map(generateKey(), (next) => {
        const current = set.keys.find((key) => key.kid === set.current);
        set = { current: next.kid, keys: current === undefined ? [next] : [next, current] };

        return next.kid;
      }),
      retirePrevious: Effect.sync(() => {
        set = { current: set.current, keys: set.keys.filter((key) => key.kid === set.current) };
      }),
    };

    return Context.make(KeyStore, {
      signingKeys: Effect.sync(() => Redacted.make(set)),
    }).pipe(Context.add(KeyStoreTestControl, control));
  }),
);
