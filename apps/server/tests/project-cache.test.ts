/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives the HTTP adapter at the boundary. */
import { expect, test } from "bun:test";
import { ApiKeyVerificationError } from "@repo/auth";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { AuditLogD1Only } from "@repo/audit";
import {
  CacheTokensTest,
  CacheTokenSigner,
  CredentialResolverLive,
  ApiKeyVerifierTest,
  ApiKeyVerifier,
} from "@repo/credentials";
import { EdgeCache, EdgeCacheTest } from "@repo/artifacts";
import { operations } from "./support/permission-matrix.ts";
import { turboRoundTrip } from "./support/turbo.ts";
import { Database, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin } from "@repo/deploy-config";
import { AuthorizationAuditLive, ProjectLimits } from "@repo/projects";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Stream } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as TestClock from "effect/testing/TestClock";
import {
  CoordinatorClient,
  CoordinatorClientLive,
  CoordinatorNamespaceTest,
} from "@repo/coordinator";
import { ApiError, artifactApi } from "../src/api.ts";
import { authorizeProjectCache } from "../src/project-cache.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";

const layer = Layer.mergeAll(
  CacheTokensTest,
  CredentialResolverLive.pipe(Layer.provide(Layer.mergeAll(CacheTokensTest, ApiKeyVerifierTest()))),
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
      const put = bucket.put;
      bucket.put = (key, value, options) =>
        put(key, value, options).pipe(
          Effect.tap(() =>
            db
              .query("test.racingDelete", (db) =>
                db
                  .insert(schema.projectDeletion)
                  .values({ projectId: "b", orgId: "org", requestedAt: 1 }),
              )
              .pipe(Effect.orDie),
          ),
        );
      expect((yield* request(b, "PUT", "", "race")).status).toBe(403);
      expect(bucket.objects.has("org/b/abc")).toBe(false);
    }).pipe(Effect.provide(layer), Effect.provideService(CanonicalOrigin, "https://cache.test")),
  ));

const scopedCredentials = Layer.effect(
  ApiKeyVerifier,
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    return {
      verify: (key) => {
        const value = Redacted.value(key);

        return value === "tcache_reader" || value === "tcache_writer"
          ? Effect.succeed({
              subject: "api-key:k",
              org: "org",
              project: "a",
              scope: value === "tcache_reader" ? ("read" as const) : ("read write" as const),
              tokenId: value,
              issuedAt: now,
              expiresAt: now + 600,
            })
          : Effect.fail(new ApiKeyVerificationError({ cause: "invalid" }));
      },
    };
  }),
);

const v2Layer = Layer.mergeAll(
  CredentialResolverLive.pipe(
    Layer.provideMerge(Layer.mergeAll(CacheTokensTest, scopedCredentials)),
  ),
  InstanceSettingsRepoLive,
  AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only)),
  AuthorizationDatabaseLive.pipe(
    Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only))),
  ),
  Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100_000_000 }),
  EdgeCacheTest,
).pipe(Layer.provideMerge(DatabaseTest));

test("v2 credential matrix, warm edge-cache isolation, events and real Turbo for both credential types", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((db) => [
        db
          .insert(schema.organization)
          .values({ id: "org", slug: "team", name: "Team", createdAt: new Date(0) }),
        db.insert(schema.project).values([
          { id: "a", orgId: "org", slug: "a", name: "A", createdAt: 0 },
          { id: "b", orgId: "org", slug: "b", name: "B", createdAt: 0 },
        ]),
      ]);
      const signer = yield* CacheTokenSigner;

      const jwtWriter = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "a",
        scope: "read write",
      })).token;

      const jwtReader = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "a",
        scope: "read",
      })).token;

      const jwtOtherProject = (yield* signer.issue({
        maxTtlSeconds: 900,
        subject: "ci",
        org: "org",
        project: "b",
        scope: "read write",
      })).token;

      const bucket = memoryBucket();
      const clientEvents: string[] = [];
      const artifactOps: string[] = [];
      const denials: number[] = [];

      const api = artifactApi({
        bucket,
        token: Redacted.make("legacy"),
        authorize: authorizeProjectCache,
        edgeCacheEnabled: true,
        cache: yield* EdgeCache,
        waitUntil: (effect) => effect.pipe(Effect.asVoid),
        emitEvents: (prefix, events) =>
          Effect.sync(() => {
            clientEvents.push(`${prefix}:${events.length}`);
          }),
        emitArtifactOp: (scope, op) =>
          Effect.sync(() => {
            artifactOps.push(`${scope.prefix}:${op.method}:${op.status}`);
          }),
        auditDenial: (error) =>
          Effect.sync(() => {
            denials.push(error.status);
          }),
      });

      type Env = Exclude<
        Effect.Services<typeof api>,
        HttpServerRequest.HttpServerRequest | CanonicalOrigin
      >;

      const context = yield* Effect.context<Env>();

      const handle = (request: Request) =>
        api.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
          Effect.provideService(CanonicalOrigin, "https://cache.test"),
          Effect.provideContext(context),
          Effect.map(HttpServerResponse.toWeb),
        );

      const request = (credential: string, path: string, method = "GET", body?: string) =>
        handle(
          new Request(`https://cache.test${path}`, {
            method,
            headers: {
              authorization: `Bearer ${credential}`,
              "content-length": String(body?.length ?? 0),
              "content-type": "application/json",
            },
            body,
          }),
        );

      for (const writer of [jwtWriter, "tcache_writer"]) {
        const uploaded = yield* request(writer, "/v8/artifacts/abc123?slug=team", "PUT", "A");
        expect(uploaded.status).toBe(202);
        expect(uploaded.headers.has("warning")).toBe(writer.startsWith("tcache_"));
      }

      for (const reader of [jwtReader, "tcache_reader"]) {
        for (const operation of Object.values(operations)) {
          const response = yield* request(
            reader,
            operation.path("org"),
            operation.method,
            "body" in operation ? operation.body : undefined,
          );

          expect(response.status).toBe(operation.method === "PUT" ? 403 : 200);

          if (reader.startsWith("tcache_") && response.status === 200)
            expect(response.headers.get("warning")).toContain("less secure");
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        }
      }

      expect(clientEvents).toEqual(["org/a:1", "org/a:1"]);
      expect(artifactOps).toContain("org/a:PUT:202");
      expect((yield* request(jwtOtherProject, "/v8/artifacts/abc123")).status).toBe(404);
      yield* request(jwtOtherProject, "/v8/artifacts/abc123", "PUT", "B");
      const a = yield* request("tcache_reader", "/v8/artifacts/abc123");
      const b = yield* request(jwtOtherProject, "/v8/artifacts/abc123");
      expect(yield* Effect.promise(() => a.text())).toBe("A");
      expect(yield* Effect.promise(() => b.text())).toBe("B");
      expect(a.headers.get("x-edge-cache")).toBe("HIT");
      expect(artifactOps).toContain("org/b:GET:404");

      for (const query of [
        "?teamId=other",
        "?slug=other",
        "?slug=team&slug=other",
        "?teamId=org&teamId=other",
      ])
        expect((yield* request("tcache_reader", `/v8/artifacts/abc123${query}`)).status).toBe(403);

      // The configured shared token cannot bypass the resolver when migration mode is off.
      for (const credential of [
        "legacy",
        "unknown",
        "tcache_missing",
        "a.b.c",
        "tcache_reader extra",
      ])
        expect((yield* request(credential, "/v8/artifacts/status")).status).toBe(401);
      expect(denials).toHaveLength(5);

      const auditRows = yield* db.query("test.denials", (db) =>
        db.select().from(schema.auditEvent),
      );

      expect(
        auditRows.filter((row) => row.payload.outcome === "deny").length,
      ).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(auditRows)).not.toContain(jwtReader);

      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ port: 0, fetch: (request) => Effect.runPromise(handle(request)) }),
        ),
        (server) =>
          Effect.sync(() => {
            server.stop(true);
          }),
      );

      for (const credential of [jwtWriter, "tcache_writer"])
        yield* Effect.promise(() =>
          turboRoundTrip(`http://localhost:${server.port}`, credential, "team"),
        );
      // A warmed edge cache never bypasses live project deletion checks.
      yield* db.query("test.delete", (db) =>
        db.insert(schema.projectDeletion).values({ projectId: "a", orgId: "org", requestedAt: 1 }),
      );
      expect((yield* request("tcache_reader", "/v8/artifacts/abc123")).status).toBe(403);
    }).pipe(Effect.provide(v2Layer), Effect.scoped),
  ));

test("purging one location makes another location miss or return 404 after the generation TTL", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reader = yield* Layer.build(CoordinatorClientLive).pipe(
        Effect.map(Context.get(CoordinatorClient)),
      );
      const writer = yield* Layer.build(CoordinatorClientLive).pipe(
        Effect.map(Context.get(CoordinatorClient)),
      );
      const cache = yield* EdgeCache;
      const bucket = memoryBucket();
      yield* bucket.put("org/a/abc", Stream.make(new TextEncoder().encode("old")), {
        contentLength: 3,
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {},
      });

      const api = artifactApi({
        bucket,
        token: Redacted.make("unused"),
        edgeCacheEnabled: true,
        cache,
        waitUntil: (effect) => effect.pipe(Effect.asVoid),
        authorize: () =>
          reader.cacheGeneration("a").pipe(
            Effect.map((cacheGeneration) => ({
              prefix: "org/a",
              maxUploadBytes: 100,
              cacheGeneration,
            })),
            Effect.mapError(
              () =>
                new ApiError({
                  status: 500,
                  code: "unavailable",
                  message: "Coordinator unavailable",
                }),
            ),
          ),
      });

      const get = () =>
        api.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://cache.test/v8/artifacts/abc", {
                headers: { authorization: "Bearer test" },
              }),
            ),
          ),
          Effect.provideService(CanonicalOrigin, "https://cache.test"),
          Effect.map(HttpServerResponse.toWeb),
        );

      const first = yield* get();
      expect(first.headers.get("x-edge-cache")).toBe("MISS");
      expect(yield* Effect.promise(() => first.text())).toBe("old");
      const warm = yield* get();
      expect(warm.headers.get("x-edge-cache")).toBe("HIT");
      yield* Effect.promise(() => warm.text());
      // The purging isolate cannot delete the reader location's Cache API entries.
      yield* bucket.delete(["org/a/abc"]);
      yield* writer.invalidateCache("a");
      yield* TestClock.adjust(5_000);
      expect((yield* get()).status).toBe(404);
      yield* bucket.put("org/a/abc", Stream.make(new TextEncoder().encode("new")), {
        contentLength: 3,
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {},
      });
      const fresh = yield* get();
      expect(fresh.headers.get("x-edge-cache")).toBe("MISS");
      expect(yield* Effect.promise(() => fresh.text())).toBe("new");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(CoordinatorNamespaceTest, EdgeCacheTest, TestClock.layer())),
    ),
  ));
