import { ApiKeyLookup, ApiKeyVerificationError } from "@repo/auth";
import { Context, Effect, Layer, Redacted } from "effect";
import type { Principal } from "./principal.ts";

/** API keys retain organization ownership when their creating user leaves. */
export class ApiKeyVerifier extends Context.Service<
  ApiKeyVerifier,
  {
    readonly verify: (
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<Principal, ApiKeyVerificationError>;
  }
>()("@repo/credentials/ApiKeyVerifier") {}

export const ApiKeyVerifierLive = Layer.effect(
  ApiKeyVerifier,
  Effect.gen(function* () {
    const lookup = yield* ApiKeyLookup;
    return {
      verify: (key) =>
        lookup.verify(Redacted.value(key)).pipe(
          Effect.map((value) => ({
            subject: `api-key:${value.id}`,
            org: value.orgId,
            project: value.projectId,
            scope: value.scope,
            tokenId: value.id,
            issuedAt: Math.floor(value.issuedAt / 1000),
            expiresAt: Math.floor(value.expiresAt / 1000),
          })),
        ),
    } satisfies typeof ApiKeyVerifier.Service;
  }),
);

/** Deterministic credentials, with a fresh lookup map for each layer build. */
export const ApiKeyVerifierTest = (
  entries: readonly {
    readonly key: Redacted.Redacted<string>;
    readonly principal: Principal;
  }[] = [],
) =>
  Layer.sync(ApiKeyVerifier, () => {
    const keys = new Map(entries.map((entry) => [Redacted.value(entry.key), entry.principal]));
    return {
      verify: (key) => {
        const principal = keys.get(Redacted.value(key));
        return principal
          ? Effect.succeed(principal)
          : Effect.fail(new ApiKeyVerificationError({ cause: "Invalid API key" }));
      },
    } satisfies typeof ApiKeyVerifier.Service;
  });
