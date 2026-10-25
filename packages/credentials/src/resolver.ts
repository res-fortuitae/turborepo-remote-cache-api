import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ApiKeyVerifier } from "./api-key.ts";
import { CacheTokenVerifier } from "./cache-token.ts";
import type { Principal } from "./principal.ts";

export class CredentialInvalid extends Schema.TaggedError<CredentialInvalid>()(
  "CredentialInvalid",
  {
    message: Schema.String,
  },
) {}

export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "CredentialUnavailable",
  {
    message: Schema.String,
  },
) {}

/** Disabled unless an operator explicitly opts into migration mode. */
export class LegacyCredentialConfig extends Context.Service<
  LegacyCredentialConfig,
  {
    readonly enabled: boolean;
    readonly token: Redacted.Redacted<string>;
  }
>()("@repo/credentials/LegacyCredentialConfig") {}

export interface ResolvedCredential {
  readonly orgId: string;
  readonly projectId: string;
  readonly scopes: readonly ("read" | "write")[];
  readonly credentialType: "cacheJwt" | "apiKey" | "legacy";
  readonly credentialId: string;
  readonly subject: string;
  readonly principal: Principal;
}

export class CredentialResolver extends Context.Service<
  CredentialResolver,
  {
    readonly resolve: (
      authorization: Redacted.Redacted<string>,
    ) => Effect.Effect<ResolvedCredential, CredentialInvalid | CredentialUnavailable>;
  }
>()("@repo/credentials/CredentialResolver") {}

const invalid = () => new CredentialInvalid({ message: "Invalid cache credential" });

// Length and byte differences both contribute; never return at the first differing byte.
const equal = (a: string, b: string) => {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;

  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);

  return diff === 0;
};

const resolved = (
  principal: Principal,
  credentialType: ResolvedCredential["credentialType"],
): ResolvedCredential => ({
  orgId: principal.org,
  projectId: principal.project,
  scopes: principal.scope === "read" ? ["read"] : ["read", "write"],
  credentialType,
  credentialId: principal.tokenId,
  subject: principal.subject,
  principal,
});

export const CredentialResolverLive = Layer.effect(
  CredentialResolver,
  Effect.gen(function* () {
    const jwt = yield* CacheTokenVerifier;
    const apiKey = yield* ApiKeyVerifier;
    const legacy = yield* Effect.serviceOption(LegacyCredentialConfig);

    return {
      resolve: Effect.fn("CredentialResolver.resolve")(function* (authorization) {
        const match = /^Bearer ([^\s,]+)$/i.exec(Redacted.value(authorization));

        if (!match) return yield* invalid();
        const token = match[1]!;

        // Recognized credential types never fall back to the shared migration token.
        if (token.startsWith("tcache_"))
          return resolved(
            yield* apiKey.verify(Redacted.make(token)).pipe(Effect.mapError(invalid)),
            "apiKey",
          );

        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
          const principal = yield* jwt.verify(token).pipe(
            Effect.catchTags({
              CacheTokenInvalid: () => Effect.fail(invalid()),
              CacheTokenRevoked: () => Effect.fail(invalid()),
              KeyStoreError: () =>
                Effect.fail(
                  new CredentialUnavailable({ message: "Credential verification unavailable" }),
                ),
              CoordinatorError: () =>
                Effect.fail(
                  new CredentialUnavailable({ message: "Credential verification unavailable" }),
                ),
            }),
          );

          return resolved(principal, "cacheJwt");
        }

        if (
          Option.isSome(legacy) &&
          legacy.value.enabled &&
          token.length > 0 &&
          equal(token, Redacted.value(legacy.value.token))
        ) {
          return resolved(
            {
              subject: "legacy",
              org: "legacy",
              project: "legacy",
              scope: "read write",
              tokenId: "legacy",
              issuedAt: 0,
              expiresAt: Number.MAX_SAFE_INTEGER,
            },
            "legacy",
          );
        }

        return yield* invalid();
      }),
    } satisfies typeof CredentialResolver.Service;
  }),
);

/** Exact header fixtures; unlisted credentials fail closed. */
export const CredentialResolverTest = (
  entries: readonly {
    authorization: Redacted.Redacted<string>;
    credential: ResolvedCredential;
  }[] = [],
) =>
  Layer.sync(CredentialResolver, () => {
    const values = new Map(
      entries.map(({ authorization, credential }) => [Redacted.value(authorization), credential]),
    );

    return {
      resolve: (authorization) => {
        const value = values.get(Redacted.value(authorization));

        return value ? Effect.succeed(value) : Effect.fail(invalid());
      },
    };
  });
