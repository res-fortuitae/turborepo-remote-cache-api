/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives the HTTP adapter at the boundary. */
import { expect, test } from "bun:test";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { AuditLogD1Only } from "@repo/audit";
import { CacheTokensTest, CacheTokenSigner } from "@repo/credentials";
import { Database, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin } from "@repo/deploy-config";
import { AuthorizationAuditLive, ProjectLimits } from "@repo/projects";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactApi } from "../src/api.ts";
import { authorizeProjectCache } from "../src/project-cache.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";

const layer = Layer.mergeAll(
  CacheTokensTest,
  InstanceSettingsRepoLive,
  AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only)),
  AuthorizationDatabaseLive.pipe(
    Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only))),
  ),
  Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100 }),
).pipe(Layer.provideMerge(DatabaseTest));

test("JWT HTTP routing isolates identical hashes, rejects tenant spoofing, clamps size, archives and deletes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((db) => [
        db
          .insert(schema.organization)
          .values({ id: "org", slug: "team", name: "Team", createdAt: new Date(0) }),
        db.insert(schema.project).values([
          { id: "a", orgId: "org", slug: "a", name: "A", createdAt: 0, maxArtifactBytes: 5 },
          { id: "b", orgId: "org", slug: "b", name: "B", createdAt: 0 },
        ]),
      ]);
      const signer = yield* CacheTokenSigner;
      const a = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "a",
        scope: "read write",
      })).token;
      const b = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "b",
        scope: "read write",
      })).token;
      const reader = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "a",
        scope: "read",
      })).token;
      const bucket = memoryBucket();
      const api = artifactApi({
        bucket,
        token: Redacted.make("legacy"),
        edgeCacheEnabled: false,
        cache: createArtifactCache(false),
        waitUntil: () => Effect.void,
        authorize: authorizeProjectCache,
      });
      const request = (credential: string, method = "GET", query = "", body?: string) =>
        api.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://cache.test/v8/artifacts/abc${query}`, {
                method,
                headers: {
                  authorization: `Bearer ${credential}`,
                  "content-length": String(body?.length ?? 0),
                },
                body,
              }),
            ),
          ),
          Effect.map(HttpServerResponse.toWeb),
        );
      expect((yield* request(a, "PUT", "?slug=team", "A")).status).toBe(202);
      expect((yield* request(b, "PUT", "", "B")).status).toBe(202);
      expect(bucket.objects.size).toBe(2);
      expect([...bucket.objects.keys()]).toEqual(["org/a/abc", "org/b/abc"]);
      const download = yield* request(a);
      expect(yield* Effect.promise(() => download.text())).toBe("A");
      expect((yield* request(a, "GET", "?teamId=other")).status).toBe(403);
      expect((yield* request(a, "GET", "?slug=other")).status).toBe(403);
      expect((yield* request(a, "GET", "?teamId=org&teamId=other")).status).toBe(403);
      expect((yield* request(reader, "PUT", "", "x")).status).toBe(403);
      expect((yield* request(a, "PUT", "", "123456")).status).toBe(413);
      yield* db.query("test.archive", (db) =>
        db
          .update(schema.project)
          .set({ slug: "renamed", archivedAt: 1 })
          .where(eq(schema.project.id, "a")),
      );
      expect((yield* request(a)).status).toBe(200);
      expect((yield* request(a, "PUT", "", "x")).status).toBe(403);
      yield* db.query("test.delete", (db) =>
        db.insert(schema.projectDeletion).values({ projectId: "a", orgId: "org", requestedAt: 1 }),
      );
      expect((yield* request(a)).status).toBe(403);
      expect((yield* request(b)).status).toBe(200);
    }).pipe(Effect.provide(layer), Effect.provideService(CanonicalOrigin, "https://cache.test")),
  ));
