import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const GitHubOAuthCredentials = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.Redacted(Schema.String),
});

/**
 * Better Auth settings, decoded by the app from Secrets Store and deploy
 * config. `baseURL` is optional: without it Better Auth derives the origin
 * from each request, which suits `workers.dev` stages without a domain.
 */
export const AuthSettings = Schema.Struct({
  secret: Schema.Redacted(Schema.String),
  baseURL: Schema.optional(Schema.String),
  trustedOrigins: Schema.Array(Schema.String),
  github: Schema.optional(GitHubOAuthCredentials),
});

export type AuthSettings = typeof AuthSettings.Type;

export class AuthConfig extends Context.Service<AuthConfig, AuthSettings>()(
  "@repo/deploy-config/AuthConfig",
) {}
