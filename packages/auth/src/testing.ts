import { RateLimiterTest } from "@repo/ratelimit";
import { AuditLogTest } from "@repo/audit/testing";
import { DatabaseTest } from "@repo/db/testing";
import { AuthConfig, type AuthSettings } from "@repo/deploy-config";
import { MailerNoop } from "@repo/mailer";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthLive } from "./auth.ts";

export const AuthConfigTest = Layer.succeed(AuthConfig, {
  secret: Redacted.make("auth-test-secret-0123456789abcdef0123456789"),
  baseURL: "http://localhost",
  trustedOrigins: [],
});

/**
 * `AuthLive` over a fresh migrated in-memory SQLite database, no-op mail, the
 * real audit log with an in-memory sink, and no secondary storage. `Database` is exposed for seeding.
 * Import only in Bun test entry points.
 */
export const AuthTest = AuthLive.pipe(
  Layer.provide(Layer.mergeAll(RateLimiterTest, AuthConfigTest, MailerNoop, AuditLogTest)),
  Layer.provideMerge(DatabaseTest),
);

/** Configurable auth fixture over the same migrated database and test services. */
export const authTestWithSettings = (settings: Partial<AuthSettings>) =>
  AuthLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        RateLimiterTest,
        Layer.succeed(AuthConfig, {
          secret: Redacted.make("auth-test-secret-0123456789abcdef0123456789"),
          baseURL: "http://localhost",
          trustedOrigins: [],
          ...settings,
        }),
        MailerNoop,
        AuditLogTest,
      ),
    ),
    Layer.provideMerge(DatabaseTest),
  );
