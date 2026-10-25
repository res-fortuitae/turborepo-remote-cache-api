/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes live policy fixtures. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { eq } from "drizzle-orm";
import { Clock, Effect, Layer } from "effect";
import { Authorization, AuthorizationAudit, AuthorizationDatabaseLive } from "./authorization.ts";
import { AuthorizationTest } from "./testing.ts";
import type { CredentialPrincipal } from "./decision.ts";

const defaultInstancePolicy = {
  orgCreation: "admins",
  allowedEmailDomains: [],
  allowedGithubOrgs: [],
  allowedOidcIssuers: [],
  maxTokenTtlSeconds: 900,
  apiKeys: "warn",
  maxApiKeyLifetimeDays: 30,
  retentionDays: 30,
  quotaBytes: 10_000_000_000,
  requireArtifactSigning: false,
  requireBoundTokens: false,
  requirePasskeyForAdmins: false,
};

const resource = { orgId: "org", projectId: "project" };

test("live organization settings cannot loosen instance TTL, signing or binding constraints", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const authorization = yield* Authorization;
      yield* database.batch((db) => [
        db
          .insert(schema.organization)
          .values({ id: "org", name: "Org", slug: "org", createdAt: new Date(0) }),
        db
          .insert(schema.project)
          .values({ id: "project", orgId: "org", slug: "project", name: "Project", createdAt: 0 }),
        db.insert(schema.instanceSettings).values({
          id: 1,
          schemaVersion: 1,
          settings: {
            ...defaultInstancePolicy,
            maxTokenTtlSeconds: 200,
            requireArtifactSigning: true,
            requireBoundTokens: true,
          },
          updatedAt: 0,
        }),
        db.insert(schema.organizationPolicy).values({
          orgId: "org",
          settings: {
            ...defaultInstancePolicy,
            maxTokenTtlSeconds: 10000,
            requireArtifactSigning: false,
            requireBoundTokens: false,
          },
          updatedAt: 0,
        }),
      ]);
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const credential: CredentialPrincipal = {
        kind: "cacheJwt",
        id: "token",
        ...resource,
        scope: "read write",
        issuedAt: now,
        expiresAt: now + 100,
        bound: true,
        signed: true,
      };
      expect((yield* authorization.can(credential, "cache:write", resource)).allowed).toBe(true);
      expect(
        (yield* authorization.can({ ...credential, expiresAt: now + 201 }, "cache:read", resource))
          .reason,
      ).toBe("credential_lifetime");
      expect(
        (yield* authorization.can({ ...credential, signed: false }, "cache:write", resource))
          .reason,
      ).toBe("signing_required");
      expect(
        (yield* authorization.can({ ...credential, bound: false }, "cache:read", resource)).reason,
      ).toBe("binding_required");
      yield* database.query("test.tighten", (db) =>
        db
          .update(schema.organizationPolicy)
          .set({ settings: { ...defaultInstancePolicy, maxTokenTtlSeconds: 50 } })
          .where(eq(schema.organizationPolicy.orgId, "org")),
      );
      expect((yield* authorization.can(credential, "cache:read", resource)).reason).toBe(
        "credential_lifetime",
      );
      yield* database.query("test.corrupt", (db) =>
        db
          .update(schema.organizationPolicy)
          .set({ settings: { malformed: true } })
          .where(eq(schema.organizationPolicy.orgId, "org")),
      );
      expect(
        yield* authorization
          .can(credential, "cache:read", resource)
          .pipe(Effect.catchTag("AuthzError", (error) => Effect.succeed(error.reason))),
      ).toBe("unavailable");
    }).pipe(Effect.provide(AuthorizationTest)),
  ));

test.each(["absent", "failing"])(
  "required denials fail closed when the audit adapter is %s",
  (mode) => {
    let attempts = 0;
    const layer = AuthorizationDatabaseLive.pipe(
      Layer.provideMerge(DatabaseTest),
      Layer.provide(
        mode === "failing"
          ? Layer.succeed(AuthorizationAudit, {
              deny: () =>
                Effect.sync(() => {
                  attempts++;
                }).pipe(Effect.andThen(Effect.fail(new Error("audit unavailable")))),
            })
          : Layer.empty,
      ),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const authorization = yield* Authorization;
        const principal = { userId: "unknown", sessionId: "unknown" };
        expect((yield* authorization.can(principal, "delete", resource)).allowed).toBe(false);
        expect(attempts).toBe(0);
        expect(
          yield* authorization
            .require(principal, "delete", resource)
            .pipe(Effect.catchTag("AuthzError", (error) => Effect.succeed(error.reason))),
        ).toBe("unavailable");
        expect(attempts).toBe(mode === "failing" ? 1 : 0);
      }).pipe(Effect.provide(layer)),
    );
  },
);
