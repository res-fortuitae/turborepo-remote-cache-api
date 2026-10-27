/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary validates real HTTP handling and SQLite reservations. */
import { expect, test } from "bun:test";
import { Quotas, QuotasLive, QuotaDefaults } from "@repo/artifacts";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin } from "@repo/deploy-config";
import type { ResolvedCredential } from "@repo/credentials";
import { Effect, Layer, Redacted } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { ApiError, artifactApi, type ArtifactScope } from "../src/api.ts";
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
      const serve = (hash: string, method = "GET", body?: string) =>
        handler.pipe(
          Effect.provideService(
            Request.HttpServerRequest,
            Request.fromWeb(
              new globalThis.Request(`http://localhost/v8/artifacts/${hash}`, {
                method,
                headers: {
                  authorization: "Bearer test",
                  ...(body ? { "content-length": String(body.length) } : {}),
                },
                body,
              }),
            ),
          ),
          Effect.map(Response.toWeb),
        );
      expect((yield* serve("aa", "PUT", "a".repeat(60))).status).toBe(202);
      expect((yield* serve("bb", "PUT", "b".repeat(50))).status).toBe(403);
      expect((yield* serve("bb", "PUT", "b".repeat(40))).status).toBe(202);
      const status = yield* serve("status");
      expect(yield* Effect.promise(() => status.json())).toEqual({ status: "over_limit" });
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
