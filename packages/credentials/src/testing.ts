import { AuditLogTest } from "@repo/audit/testing";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer, Redacted } from "effect";
import { ArtifactSigningLive, ArtifactEncryptionSecret } from "./artifact-signing.ts";

/** Real encryption and signing lifecycle over a fresh migrated SQLite database. */
export const ArtifactSigningTest = ArtifactSigningLive.pipe(
  Layer.provideMerge(AuditLogTest),
  Layer.provide(
    Layer.succeed(ArtifactEncryptionSecret, {
      get: Effect.succeed(Redacted.make("test-wrapping-secret-at-least-32-bytes")),
    }),
  ),
  Layer.provideMerge(DatabaseTest),
);
