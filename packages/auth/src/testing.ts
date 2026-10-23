import { AuditLogTest } from "@repo/audit/testing";
import { DatabaseTest } from "@repo/db/testing";
import { AuthConfig } from "@repo/deploy-config";
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
  Layer.provide(Layer.mergeAll(AuthConfigTest, MailerNoop, AuditLogTest)),
  Layer.provideMerge(DatabaseTest),
);
