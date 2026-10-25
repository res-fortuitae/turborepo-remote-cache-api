import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

export interface OidcIssuer {
  readonly issuer: string;
  readonly algorithms: readonly ("RS256" | "ES256" | "EdDSA")[];
  /** Explicit origins trusted to serve this provider's keys, never token header URLs. */
  readonly jwksOrigins: readonly string[];
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
