import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CustomOidcIssuers } from "@repo/deploy-config";
import { providerProfile } from "./provider-profiles.ts";
import type { Jwks } from "./jwks-cache.ts";
import type { JWTPayload } from "jose";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

export interface OidcIssuer {
  readonly issuer: string;
  readonly algorithms: readonly ("RS256" | "ES256" | "EdDSA")[];
  /** Explicit origins trusted to serve this provider's keys, never token header URLs. */
  readonly jwksOrigins: readonly string[];
  /** Provider lifetime ceiling, independent of the configured maximum token age. */
  readonly maxTokenLifetimeSeconds?: number;
  readonly pinnedKeys?: Jwks;
  readonly optionalTokenId?: boolean;
  readonly optionalNotBefore?: boolean;
  readonly validateClaims?: (claims: JWTPayload) => boolean;
}

export class IssuerRegistry extends Context.Service<
  IssuerRegistry,
  {
    readonly find: (issuer: string) => Option.Option<OidcIssuer>;
  }
>()("@repo/oidc/IssuerRegistry") {}

/** GitHub Enterprise Cloud's per-enterprise issuer needs an exact policy allowlist entry too. */
export const GitHubIssuerRegistry = Layer.succeed(IssuerRegistry, {
  find: (issuer) =>
    issuer === GITHUB_ACTIONS_ISSUER ||
    /^https:\/\/token\.actions\.githubusercontent\.com\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
      issuer,
    )
      ? Option.some({ issuer, algorithms: ["RS256"], jwksOrigins: [GITHUB_ACTIONS_ISSUER] })
      : Option.none(),
});

export const VERCEL_ISSUER = "https://oidc.vercel.com";

export const VercelClaims = Schema.Struct({
  owner: Schema.NonEmptyString,
  owner_id: Schema.String.check(Schema.isPattern(/^team_[A-Za-z0-9]+$/)),
  project: Schema.NonEmptyString,
  project_id: Schema.String.check(Schema.isPattern(/^prj_[A-Za-z0-9]+$/)),
  environment: Schema.NonEmptyString,
});

const isVercelClaims = Schema.is(VercelClaims);

/** Registration never enables an issuer: the effective exact allowlist still applies. */
export const BuiltinIssuerRegistry = Layer.effect(
  IssuerRegistry,
  Effect.map(IssuerRegistry, (github) => ({
    find: (issuer: string): Option.Option<OidcIssuer> => {
      if (/^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/.test(issuer))
        return Option.some({
          issuer,
          algorithms: ["RS256"],
          jwksOrigins: [VERCEL_ISSUER],
          maxTokenLifetimeSeconds: 7200,
          validateClaims: isVercelClaims,
        });
      const profile = providerProfile(issuer);

      return profile === undefined
        ? github.find(issuer)
        : Option.some({ issuer, algorithms: ["RS256"], ...profile });
    },
  })),
).pipe(Layer.provide(GitHubIssuerRegistry));

export class CustomIssuerConfig extends Context.Service<
  CustomIssuerConfig,
  typeof CustomOidcIssuers.Type
>()("@repo/oidc/CustomIssuerConfig") {}

export const CustomIssuerDefaults = Layer.succeed(CustomIssuerConfig, []);

const decodeCustomIssuers = Schema.decodeUnknownEffect(CustomOidcIssuers);

export const ConfiguredIssuerRegistry = Layer.effect(
  IssuerRegistry,
  Effect.gen(function* () {
    const builtin = yield* IssuerRegistry;
    const entries = yield* Effect.orDie(decodeCustomIssuers(yield* CustomIssuerConfig));

    return {
      find: (issuer: string): Option.Option<OidcIssuer> => {
        const found = builtin.find(issuer);

        if (Option.isSome(found)) return found;
        const entry = entries.find((entry) => entry.issuer === issuer);

        return entry === undefined
          ? Option.none()
          : Option.some({
              issuer,
              algorithms: ["RS256"],
              jwksOrigins: [],
              pinnedKeys: { keys: entry.keys },
              optionalTokenId: true,
              optionalNotBefore: true,
            });
      },
    };
  }),
).pipe(Layer.provide(BuiltinIssuerRegistry));
