/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary validates real HTTP handling and SQLite reservations. */
import { expect, test } from "bun:test";
import {
  Quotas,
  QuotasLive,
  QuotaDefaults,
  QuotaUnavailable,
  MultipartUploads,
  type UploadTicket,
} from "@repo/artifacts";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin } from "@repo/deploy-config";
import type { ResolvedCredential } from "@repo/credentials";
import { Effect, Layer, Redacted } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { ApiError, artifactApi, type ArtifactScope } from "../src/api.ts";
import { multipartRoute } from "../src/multipart-route.ts";
import { admitQuotaUpload } from "../src/quota-upload.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";
const layer = QuotasLive.pipe(
  Layer.provideMerge(AuditLogTest),
  Layer.provide(Layer.succeed(QuotaDefaults, { storageBytes: () => Effect.succeed(100) })),
  Layer.provideMerge(DatabaseTest),
);
const credential: ResolvedCredential = {
  orgId: "o",
  projectId: "p",
  scopes: ["read", "write"],
  credentialType: "cacheJwt",
  credentialId: "t",
  subject: "ci",
  principal: {
    org: "o",
    project: "p",
    subject: "ci",
    scope: "read write",
    tokenId: "t",
    issuedAt: 0,
    expiresAt: 9999999999,
  },
};

test("HTTP quota admission reports over_limit while stored reads keep working", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database,
        quotas = yield* Quotas;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "o", slug: "o", name: "O", createdAt: new Date() }),
        q
          .insert(schema.project)
          .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
      ]);
      const bucket = memoryBucket();
      const scope: ArtifactScope = { prefix: "o/p", credential, maxUploadBytes: 1000 };
      const failed = () =>
        new ApiError({ status: 503, code: "storage", message: "Storage unavailable" });
      const handler = artifactApi({
        bucket,
        token: Redacted.make("unused"),
        edgeCacheEnabled: false,
        cache: createArtifactCache(false),
        waitUntil: () => Effect.void,
        authorize: () => Effect.succeed(scope),
        overQuota: () =>
          quotas.status({ orgId: "o", projectId: "p" }).pipe(
            Effect.map((status) => status.overLimit),
            Effect.mapError(failed),
          ),
        withinUploadQuota: (scope, hash, size, upload) =>
          admitQuotaUpload(scope, hash, size, 1000, upload, {
            head: (key) => bucket.head(key).pipe(Effect.mapError(failed)),
            remove: (key) => bucket.delete([key]).pipe(Effect.mapError(failed)),
          }).pipe(Effect.provideService(Quotas, quotas)),
      });
      const serve = (hash: string, method = "GET", body?: string, length?: string) =>
        handler.pipe(
          Effect.provideService(
            Request.HttpServerRequest,
            Request.fromWeb(
              new globalThis.Request(`http://localhost/v8/artifacts/${hash}`, {
                method,
                headers: {
                  authorization: "Bearer test",
                  ...(body ? { "content-length": length ?? String(body.length) } : {}),
                },
                body,
              }),
            ),
          ),
          Effect.map(Response.toWeb),
        );
      const held = yield* quotas.reserve({ orgId: "o", projectId: "p" }, "aa", 60);
      const busy = yield* serve("aa", "PUT", "a".repeat(60));
      expect(busy.status).toBe(429);
      expect(busy.headers.get("retry-after")).toBe("1");
      yield* quotas.release(held);
      expect((yield* serve("aa", "PUT", "a".repeat(60))).status).toBe(202);
      expect((yield* serve("bb", "PUT", "b".repeat(50))).status).toBe(403);
      expect((yield* serve("bb", "PUT", "b".repeat(40))).status).toBe(202);
      expect((yield* serve("cc", "PUT", "c", "abc")).status).toBe(400);
      expect((yield* serve("cc", "PUT", "c", "-1")).status).toBe(400);
      expect((yield* serve("cc", "PUT", "c", "1001")).status).toBe(413);
      const status = yield* serve("status");
      expect(yield* Effect.promise(() => status.json())).toEqual({ status: "enabled" });
      const read = yield* serve("aa");
      expect(read.status).toBe(200);
      expect(yield* Effect.promise(() => read.text())).toBe("a".repeat(60));
      expect((yield* serve("cc", "PUT", "c")).status).toBe(403);
      expect(
        (yield* quotas.status({ orgId: "o", projectId: "p" })).project.usage.reservedBytes,
      ).toBe(0);
    }).pipe(Effect.provide(layer), Effect.provideService(CanonicalOrigin, "http://localhost")),
  );
});

test.each(["accounting", "purge"] as const)(
  "multipart completion cleans up when %s fails",
  async (failure) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        const quotas = yield* Quotas;
        yield* db.batch((q) => [
          q
            .insert(schema.organization)
            .values({ id: "o", name: "O", slug: "o", createdAt: new Date(0) }),
          q
            .insert(schema.project)
            .values({ id: "p", orgId: "o", name: "P", slug: "p", createdAt: 0 }),
        ]);
        const reservation = yield* quotas.reserve({ orgId: "o", projectId: "p" }, "aa", 10);
        const ticket: UploadTicket = {
          uploadId: "upload",
          key: "o/p/aa",
          orgId: "o",
          projectId: "p",
          credentialId: "t",
          hash: "aa",
          size: 10,
          generation: 0,
          expiresAt: 9999999999999,
          session: "session",
          quotaReservation: reservation,
          provenance: {},
        };
        let stored = false;
        let invalidated = false;
        let emitted = false;
        const uploads: typeof MultipartUploads.Service = {
          create: () => Effect.die("not used"),
          resolve: () => Effect.succeed(ticket),
          part: () => Effect.die("not used"),
          abort: () => Effect.void,
          complete: () =>
            Effect.sync(() => {
              stored = true;
              return true;
            }),
          remove: () =>
            Effect.sync(() => {
              stored = false;
            }),
        };
        const scope: ArtifactScope = {
          prefix: "o/p",
          credential,
          maxUploadBytes: 100,
          cacheGeneration: 0,
        };
        const result = yield* multipartRoute(
          scope,
          Effect.succeed(failure === "purge" ? { ...scope, cacheGeneration: 1 } : scope),
          () =>
            Effect.sync(() => {
              emitted = true;
            }),
          () =>
            Effect.sync(() => {
              invalidated = true;
            }),
        ).pipe(
          Effect.provideService(MultipartUploads, uploads),
          Effect.provideService(Quotas, {
            ...quotas,
            finish:
              failure === "accounting" ? () => Effect.fail(new QuotaUnavailable()) : quotas.finish,
          }),
          Effect.provideService(
            Request.HttpServerRequest,
            Request.fromWeb(
              new globalThis.Request("http://localhost/v8/x/uploads/ticket/complete", {
                method: "POST",
                body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag" }] }),
              }),
            ),
          ),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(stored).toBe(false);
        expect(invalidated).toBe(true);
        expect(emitted).toBe(false);
        expect(
          (yield* quotas.status({ orgId: "o", projectId: "p" })).project.usage.storageBytes,
        ).toBe(0);
        expect(
          (yield* quotas.status({ orgId: "o", projectId: "p" })).project.usage.reservedBytes,
        ).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  },
);

test("interruption releases admitted upload capacity", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const quotas = yield* Quotas;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "o", slug: "o", name: "O", createdAt: new Date(0) }),
        q
          .insert(schema.project)
          .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
      ]);
      const result = yield* admitQuotaUpload(
        { prefix: "o/p", credential, maxUploadBytes: 100 },
        "aa",
        10,
        100,
        Effect.interrupt,
        { head: () => Effect.succeed(null), remove: () => Effect.void },
      ).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(
        (yield* quotas.status({ orgId: "o", projectId: "p" })).project.usage.reservedBytes,
      ).toBe(0);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        Request.HttpServerRequest,
        Request.fromWeb(new globalThis.Request("http://localhost/v8/artifacts/aa")),
      ),
    ),
  );
});

test("multipart creation uses a short renewable reservation rather than the ticket lifetime", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const quotas = yield* Quotas;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "o", slug: "o", name: "O", createdAt: new Date(0) }),
        q
          .insert(schema.project)
          .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
      ]);
      let lease = 0;
      const response = yield* multipartRoute(
        { prefix: "o/p", credential, maxUploadBytes: 100 },
        Effect.die("not used"),
        () => Effect.void,
        () => Effect.void,
      ).pipe(
        Effect.provideService(Quotas, quotas),
        Effect.provideService(MultipartUploads, {
          create: (owner) =>
            Effect.gen(function* () {
              const rows = yield* db.query("test.reservation", (q) =>
                q.select().from(schema.quotaReservation),
              );
              lease = rows[0]!.expiresAt - Date.now();
              return { id: "upload", partSize: 10, expiresAt: owner.expiresAt! };
            }).pipe(Effect.orDie),
          resolve: () => Effect.die("not used"),
          part: () => Effect.die("not used"),
          abort: () => Effect.void,
          complete: () => Effect.die("not used"),
          remove: () => Effect.void,
        }),
        Effect.provideService(
          Request.HttpServerRequest,
          Request.fromWeb(
            new globalThis.Request("http://localhost/v8/x/uploads", {
              method: "POST",
              body: JSON.stringify({ hash: "aa", size: 10 }),
            }),
          ),
        ),
      );
      expect(response.status).toBe(201);
      expect(lease).toBeGreaterThan(0);
      expect(lease).toBeLessThanOrEqual(300_000);
    }).pipe(Effect.provide(layer)),
  );
});
