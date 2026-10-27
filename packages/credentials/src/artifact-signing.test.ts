import { ArtifactSigningTest } from "./testing.ts";
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary runs real migrated SQLite and Web Crypto. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";

import { Effect, Redacted } from "effect";
import { ArtifactSigning, encryptArtifactKey, decryptArtifactKey } from "./artifact-signing.ts";

const secret = "test-wrapping-secret-at-least-32-bytes";
const event = {
  scope: "org" as const,
  orgId: "org",
  projectId: "project",
  actor: { type: "user" as const, id: "u", display: "User" },
  action: "test",
  target: { type: "project", id: "project" },
  outcome: "allow" as const,
  ip: "",
  userAgent: "",
  requestId: "request",
  metadata: {},
};
const layer = ArtifactSigningTest;

test("envelopes authenticate tenant, project and key ID and never contain plaintext", async () => {
  const key = "random-artifact-hmac-key-at-least-32-bytes";
  const encrypted = await encryptArtifactKey(secret, key, "o", "p", "k");
  expect(encrypted).not.toContain(key);
  expect(await decryptArtifactKey(secret, encrypted, "o", "p", "k")).toBe(key);
  await expect(decryptArtifactKey(secret, encrypted, "other", "p", "k")).rejects.toThrow();
  await expect(decryptArtifactKey("wrong", encrypted, "o", "p", "k")).rejects.toThrow();
  const value = JSON.parse(encrypted);
  value.ciphertext = value.ciphertext.slice(0, -4) + "AAAA";
  await expect(decryptArtifactKey(secret, JSON.stringify(value), "o", "p", "k")).rejects.toThrow();
});

test("rotation stores encrypted keys, audits access, retains one overlap and isolates projects", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const signing = yield* ArtifactSigning,
        db = yield* Database;
      yield* signing.rotate("org", "project", event);
      const first = yield* signing.deliver("org", "project", event);
      expect(Redacted.value(first!.signatureKey).length).toBeGreaterThanOrEqual(32);
      const stored = yield* db.query("test.keys", (q) =>
        q.select().from(schema.artifactSigningKey),
      );
      expect(JSON.stringify(stored)).not.toContain(Redacted.value(first!.signatureKey));
      yield* signing.rotate("org", "project", event);
      const second = yield* signing.deliver("org", "project", event);
      expect(Redacted.value(second!.signatureKey)).not.toBe(Redacted.value(first!.signatureKey));
      expect(Redacted.value(second!.previousSignatureKeys[0]!)).toBe(
        Redacted.value(first!.signatureKey),
      );
      expect((yield* Effect.result(signing.rotate("org", "project", event)))._tag).toBe("Failure");
      expect(yield* signing.deliver("other", "project", event)).toBeUndefined();
      const metadata = yield* signing.status("project");
      expect(JSON.stringify(metadata)).not.toContain(Redacted.value(first!.signatureKey));
      const audit = yield* db.query("test.audit", (q) => q.select().from(schema.auditEvent));
      expect(audit.some((row) => row.payload.action === "artifact.signing.access")).toBe(true);
      yield* signing.configure("project", true, event);
      expect((yield* signing.status("project")).required).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
