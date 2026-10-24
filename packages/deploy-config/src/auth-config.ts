import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const GitHubOAuthCredentials = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.Redacted(Schema.String),
});

/**
 * Better Auth settings, decoded by the app from Secrets Store and deploy
 * config. The Worker supplies the canonical origin for `baseURL` and
 * `trustedOrigins`, including workers.dev and local stages. The optional
 * field also permits standalone consumers to use Better Auth's default.
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
