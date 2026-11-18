/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun exercises live composed services at this boundary. */
import { expect, test } from "bun:test";
import { DeveloperTokenRequest } from "@repo/api-spec";
import { AuthTest } from "@repo/auth/testing";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, ProjectRepoLive, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin, defaultInstancePolicy } from "@repo/deploy-config";
import { RateLimiterTest } from "@repo/ratelimit";
import { Effect, Layer, Redacted, Schema } from "effect";
import { eq } from "drizzle-orm";
import { DeveloperTokens, DeveloperTokensLive } from "./developer-token.ts";
import {
  CacheTokensTest,
  CacheTokenVerifier,
  DEFAULT_CACHE_TOKEN_TTL_SECONDS,
} from "./cache-token.ts";
import {
  ArtifactEncryptionSecret,
  ArtifactSigning,
  ArtifactSigningLive,
} from "./artifact-signing.ts";

const dependencies = Layer.mergeAll(
  AuthTest,
  AuthorizationDatabaseLive,
  AuditLogTest,
  ArtifactSigningLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        AuditLogTest,
        Layer.succeed(ArtifactEncryptionSecret, {
          get: Effect.succeed(Redacted.make("test-secret")),
        }),
      ),
    ),
  ),
  ProjectRepoLive,
  InstanceSettingsRepoLive,
  CacheTokensTest,
  RateLimiterTest,
  Layer.succeed(CanonicalOrigin, "http://localhost"),
);
const layer = DeveloperTokensLive.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(DatabaseTest),
);

test("developer tokens default to read, require both write policy and grants, and refresh checks live state", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const tokens = yield* DeveloperTokens;
      const verifier = yield* CacheTokenVerifier;
      const now = new Date();
      yield* db.batch((db) => [
        db.insert(schema.user).values({
          id: "u",
          name: "User",
          email: "u@example.com",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "s",
          token: "dev-session",
          userId: "u",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + 604800000),
        }),
        db
          .insert(schema.organization)
          .values({ id: "org", slug: "org", name: "Org", createdAt: now }),
        db
          .insert(schema.member)
          .values({ id: "m", userId: "u", organizationId: "org", role: "member", createdAt: now }),
        db
          .insert(schema.project)
          .values({ id: "project", orgId: "org", slug: "app", name: "App", createdAt: Date.now() }),
        db.insert(schema.projectGrant).values({
          projectId: "project",
          principalType: "user",
          principalId: "u",
          role: "cache:write",
          grantedBy: "u",
          createdAt: Date.now(),
        }),
      ]);
      const headers = new Headers({
        authorization: "Bearer dev-session",
        origin: "http://localhost",
        "cf-connecting-ip": "192.0.2.1",
      });
      const request = {
        team: "org",
        project: "project",
        ttlSeconds: DEFAULT_CACHE_TOKEN_TTL_SECONDS,
      };
      const decode = Schema.decodeUnknownSync(DeveloperTokenRequest);
      expect(decode(request)).toEqual(request);
      const overLimit = { ...request, ttlSeconds: request.ttlSeconds + 1 };
      expect(() => decode(overLimit)).toThrow();
      expect((yield* Effect.flip(tokens.issue(overLimit, headers))).status).toBe(400);
      const signing = yield* ArtifactSigning;
      yield* signing.rotate("org", "project", {
        scope: "org",
        orgId: "org",
        projectId: "project",
        actor: { type: "user", id: "u", display: "User" },
        action: "artifact.signing.rotate",
        target: { type: "project", id: "project" },
        outcome: "allow",
        ip: "",
        userAgent: "",
        requestId: "rotation",
        metadata: {},
      });
      const read = yield* tokens.issue(request, headers);
      expect(read.scope).toBe("read");
      expect(read.signatureKey).toBeUndefined();
      expect(read.previousSignatureKeys).toBeUndefined();
      const principal = yield* verifier.verify(Redacted.value(read.token));
      expect(principal.subject).toBe("user:u");
      yield* db.query("test.removeMember", (db) => db.delete(schema.member));
      expect((yield* Effect.flip(verifier.verify(Redacted.value(read.token))))._tag).toBe(
        "CacheTokenRevoked",
      );
      yield* db.query("test.reinvite", (db) =>
        db.insert(schema.member).values({
          id: "new-membership",
          userId: "u",
          organizationId: "org",
          role: "member",
          createdAt: now,
        }),
      );
      expect((yield* Effect.flip(verifier.verify(Redacted.value(read.token))))._tag).toBe(
        "CacheTokenRevoked",
      );

      expect(principal.expiresAt - principal.issuedAt).toBeLessThanOrEqual(900);
      expect((yield* Effect.flip(tokens.issue({ ...request, write: true }, headers))).status).toBe(
        403,
      );
      yield* db.query("test.policy", (db) =>
        db.insert(schema.instanceSettings).values({
          id: 1,
          settings: JSON.parse(
            JSON.stringify({
              ...defaultInstancePolicy,
              developerCacheWrites: true,
            }),
          ),
          schemaVersion: 1,
          updatedAt: Date.now(),
        }),
      );
      const write = yield* tokens.issue({ ...request, write: true }, headers);
      expect(write.scope).toBe("read write");
      expect(write.signatureKey).toBeDefined();
      expect(
        (yield* Effect.flip(tokens.issue({ ...request, team: "other" }, headers))).status,
      ).toBe(403);
      expect(
        (yield* Effect.flip(
          tokens.issue(
            request,
            new Headers({ authorization: "Bearer dev-session", origin: "https://evil.test" }),
          ),
        )).status,
      ).toBe(403);
      yield* db.query("test.revokeGrant", (db) =>
        db.delete(schema.projectGrant).where(eq(schema.projectGrant.projectId, "project")),
      );
      expect((yield* Effect.flip(tokens.issue(request, headers))).status).toBe(403);
      yield* db.query("test.revokeSession", (db) =>
        db.delete(schema.session).where(eq(schema.session.id, "s")),
      );
      expect((yield* Effect.flip(tokens.issue(request, headers))).status).toBe(401);
      const events = yield* db.query("test.events", (db) => db.select().from(schema.auditEvent));
      expect(events.filter((e) => e.payload.action === "token.developer.issue")).toHaveLength(2);
      expect(events.filter((e) => e.payload.action === "artifact.signing.access")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(Redacted.value(read.token));
    }).pipe(Effect.provide(layer)),
  );
});
