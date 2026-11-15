/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- HTTP and streaming adapters at the Bun boundary. */
import { expect, test } from "bun:test";
import { MultipartCreated } from "@repo/api-spec";
import { MultipartUploadsLive, MultipartBucket, MultipartSecret, Quotas } from "@repo/artifacts";
import { CanonicalOrigin } from "@repo/deploy-config";
import type { ResolvedCredential } from "@repo/credentials";
import { Database, schema } from "@repo/db";
import { QuotasTest } from "@repo/artifacts/testing";
import { Clock, Effect, Layer, Redacted, Stream, Schema } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { artifactApi, ApiError } from "../src/api.ts";
import { multipartRoute } from "../src/multipart-route.ts";
import { createArtifactCache } from "../src/edge-cache.ts";
import { memoryBucket } from "./support/in-process.ts";

export const multipartFixture = (
  quotas?: typeof Quotas.Service,
  clock?: Clock.Clock,
  onCreate?: () => void,
  onArtifactOp?: () => void,
) => {
  const bucket = memoryBucket();
  const uploads = new Map<
    string,
    { key: string; meta: Record<string, string>; parts: Map<number, Uint8Array> }
  >();
  const operations: string[] = [];
  let generation = 0;
  let race = false;
  let recheckFailure = false;
  const layer = MultipartUploadsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MultipartSecret, Redacted.make("test-secret-for-upload-handles")),
        Layer.succeed(MultipartBucket, {
          create: (key, meta) =>
            Effect.sync(() => {
              onCreate?.();
              const id = crypto.randomUUID();
              uploads.set(id, { key, meta, parts: new Map() });
              operations.push("create");
              return id;
            }),
          part: (ticket, number, body, size) =>
            Stream.runCollect(body).pipe(
              Effect.map((chunks) => {
                const bytes = new Uint8Array(Bun.concatArrayBuffers([...chunks]));
                if (bytes.length !== size) throw new Error("Wrong stream length");
                uploads.get(ticket.uploadId)!.parts.set(number, bytes);
                operations.push("part");
                return { partNumber: number, etag: `etag-${number}` };
              }),
            ),
          complete: (ticket) =>
            Effect.try(() => {
              const upload = uploads.get(ticket.uploadId);
              if (!upload) throw new Error("Upload already completed");
              uploads.delete(ticket.uploadId);
              const bytes = new Uint8Array(Bun.concatArrayBuffers([...upload.parts.values()]));
              bucket.objects.set(upload.key, {
                bytes,
                size: bytes.length,
                customMetadata: upload.meta,
              });
              operations.push("complete");
              if (race) generation++;
            }),
          abort: (ticket) =>
            Effect.sync(() => {
              uploads.delete(ticket.uploadId);
              operations.push("abort");
            }),
          head: (key) =>
            Effect.sync(() => {
              const object = bucket.objects.get(key);
              return object
                ? { size: object.size, session: object.customMetadata?.uploadSession }
                : null;
            }),
          remove: (key) => bucket.delete([key]),
        }),
      ),
    ),
  );
  const credential = (token: string): ResolvedCredential => ({
    orgId: token === "other-org" ? "other" : "o",
    projectId: "p",
    credentialType: "cacheJwt",
    credentialId: token.startsWith("bound-") ? token : token === "other-key" ? "other-key" : "key",
    subject: "ci",
    scopes: ["read", "write"],
    principal: {
      subject: "ci",
      cnf: token.startsWith("bound-")
        ? { jkt: (token === "bound-other" ? "B" : "A").repeat(43) }
        : undefined,
      org: "o",
      project: "p",
      scope: "read write",
      tokenId: "key",
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  });
  const api = artifactApi({
    bucket,
    emitArtifactOp: () => Effect.sync(() => onArtifactOp?.()),
    token: Redacted.make("unused"),
    edgeCacheEnabled: false,
    cache: createArtifactCache(false),
    waitUntil: (effect) => effect,
    authorize: (token, _url, action) =>
      token === "read" && action === "cache:write"
        ? Effect.fail(new ApiError({ status: 403, code: "forbidden", message: "Read only" }))
        : Effect.succeed({
            prefix: `${credential(token).orgId}/p`,
            maxUploadBytes: 2_000_000_000,
            credential: credential(token),
            cacheGeneration: generation,
          }),
    multipart: (scope, recheck) =>
      multipartRoute(
        scope,
        recheck.pipe(
          Effect.flatMap((scope) =>
            recheckFailure
              ? Effect.fail(new ApiError({ status: 403, code: "forbidden", message: "Revoked" }))
              : Effect.succeed(scope),
          ),
        ),
        () => Effect.void,
        () => Effect.void,
      ).pipe(
        Effect.provide(quotas ? Layer.merge(layer, Layer.succeed(Quotas, quotas)) : layer),
        Effect.mapError((error) =>
          error instanceof ApiError
            ? error
            : new ApiError({ status: 503, code: "unavailable", message: "Upload unavailable" }),
        ),
      ),
  });
  const serve = (
    path: string,
    method = "POST",
    token = "write",
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    Effect.runPromise(
      api.pipe(
        Effect.provideService(
          Request.HttpServerRequest,
          Request.fromWeb(
            new globalThis.Request(`http://localhost${path}`, {
              method,
              headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
              ...(body === undefined ? {} : { body }),
            }),
          ),
        ),
        Effect.provide(clock ? Layer.succeed(Clock.Clock, clock) : Layer.empty),
        Effect.provideService(CanonicalOrigin, "http://localhost"),
        Effect.map(Response.toWeb),
      ),
    );
  return {
    serve,
    bucket,
    operations,
    setRecheckFailure: (value: boolean) => {
      recheckFailure = value;
    },
    setRace: () => {
      race = true;
    },
    setGeneration: () => {
      generation++;
    },
  };
};

const create = async (serve: ReturnType<typeof multipartFixture>["serve"]) => {
  const response = await serve("/v8/x/uploads", "POST", "write", '{"hash":"abc","size":5}', {
    "x-artifact-duration": "42",
    "x-artifact-tag": "signature",
    "x-artifact-credential-id": "spoof",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

test("multipart applies write scope and tenant binding on every endpoint; metadata survives complete and replay", async () => {
  const { serve, bucket, operations } = multipartFixture();
  expect((await serve("/v8/x/uploads", "POST", "", "{}")).status).toBe(401);
  expect((await serve("/v8/x/uploads", "POST", "read", "{}")).status).toBe(403);
  expect(operations).toEqual([]);
  const id = await create(serve);
  const path = `/v8/x/uploads/${id}`;
  expect(
    (await serve(`${path}/parts/1`, "PUT", "other-org", "hello", { "content-length": "5" })).status,
  ).toBe(403);
  expect(
    (await serve(`${path}/parts/1`, "PUT", "other-key", "hello", { "content-length": "5" })).status,
  ).toBe(403);
  expect(
    (await serve(`${path}/parts/2`, "PUT", "write", "hello", { "content-length": "5" })).status,
  ).toBe(400);
  expect(
    (await serve(`${path}/parts/1`, "PUT", "write", "hello", { "content-length": "6" })).status,
  ).toBe(400);
  const tampered = `${id.slice(0, -4)}aaaa`;
  expect((await serve(`/v8/x/uploads/${tampered}/abort`)).status).toBe(400);
  expect((await serve(`${path}/complete`, "POST", "write", '{"parts":[]}')).status).toBe(400);
  const part = await serve(`${path}/parts/1`, "PUT", "write", "hello", { "content-length": "5" });
  expect(part.status).toBe(200);
  const complete = JSON.stringify({ parts: [await part.json()] });
  expect((await serve(`${path}/complete`, "POST", "write", complete)).status).toBe(202);
  expect((await serve(`${path}/complete`, "POST", "write", complete)).status).toBe(202);
  expect(operations.filter((o) => o === "complete")).toHaveLength(1);
  expect(bucket.objects.get("o/p/abc")?.customMetadata).toMatchObject({
    duration: "42",
    tag: "signature",
    credentialId: "key",
    credentialType: "cacheJwt",
  });
  const downloaded = await serve("/v8/artifacts/abc", "GET");
  expect(await downloaded.text()).toBe("hello");
  expect(downloaded.headers.get("x-artifact-tag")).toBe("signature");
});

test("purged upload handles cannot commit, can abort, and a purge racing completion removes the object", async () => {
  const fixture = multipartFixture();
  const id = await create(fixture.serve);
  fixture.setGeneration();
  expect(
    (
      await fixture.serve(`/v8/x/uploads/${id}/parts/1`, "PUT", "write", "hello", {
        "content-length": "5",
      })
    ).status,
  ).toBe(409);
  expect((await fixture.serve(`/v8/x/uploads/${id}/abort`)).status).toBe(204);
  const id2 = await create(fixture.serve);
  const part = await fixture.serve(`/v8/x/uploads/${id2}/parts/1`, "PUT", "write", "hello", {
    "content-length": "5",
  });
  fixture.setRace();
  expect(
    (
      await fixture.serve(
        `/v8/x/uploads/${id2}/complete`,
        "POST",
        "write",
        JSON.stringify({ parts: [await part.json()] }),
      )
    ).status,
  ).toBe(409);
  expect(fixture.bucket.objects.size).toBe(0);
});

test("direct upload ceilings reject before storage while multipart observes whole-object policy", async () => {
  const { serve, bucket, operations } = multipartFixture();
  const direct = await serve("/v8/artifacts/abc", "PUT", "write", "x", {
    "content-length": "150000000",
  });
  expect(direct.status).toBe(413);
  expect(await direct.json()).toMatchObject({
    code: "payload_too_large",
    message: expect.stringContaining("tcache exec"),
  });
  expect(bucket.objects.size).toBe(0);
  expect(
    (await serve("/v8/x/uploads", "POST", "write", '{"hash":"abc","size":3000000000}')).status,
  ).toBe(413);
  expect(operations).toEqual([]);
});

test("multipart survives bound JWT refresh but refuses a different proof key", async () => {
  const { serve } = multipartFixture();
  const created = await serve("/v8/x/uploads", "POST", "bound-initial", '{"hash":"abc","size":3}');
  expect(created.status).toBe(201);
  const upload = Schema.decodeUnknownSync(MultipartCreated)(await created.json());
  const path = `/v8/x/uploads/${encodeURIComponent(upload.id)}`;
  expect(
    (await serve(`${path}/parts/1`, "PUT", "bound-other", "abc", { "content-length": "3" })).status,
  ).toBe(403);
  const response = await serve(`${path}/parts/1`, "PUT", "bound-refreshed", "abc", {
    "content-length": "3",
  });
  expect(response.status).toBe(200);
  const part = await response.json();
  expect(
    (
      await serve(
        `${path}/complete`,
        "POST",
        "bound-refreshed-again",
        JSON.stringify({ parts: [part] }),
      )
    ).status,
  ).toBe(202);
});

test("completion replay with real quotas preserves the artifact and ledgers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const quotas = yield* Quotas;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "o", slug: "o", name: "O", createdAt: new Date() }),
        q
          .insert(schema.project)
          .values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
      ]);
      yield* Effect.promise(async () => {
        const fixture = multipartFixture(quotas);
        const id = await create(fixture.serve);
        const path = `/v8/x/uploads/${id}`;
        const part = await fixture.serve(`${path}/parts/1`, "PUT", "write", "hello", {
          "content-length": "5",
        });
        const manifest = JSON.stringify({ parts: [await part.json()] });
        expect((await fixture.serve(`${path}/complete`, "POST", "write", manifest)).status).toBe(
          202,
        );
        expect((await fixture.serve(`${path}/complete`, "POST", "write", manifest)).status).toBe(
          202,
        );
        expect(fixture.bucket.objects.get("o/p/abc")?.size).toBe(5);
        fixture.setRecheckFailure(true);
        expect((await fixture.serve(`${path}/complete`, "POST", "write", manifest)).status).toBe(
          403,
        );
        expect(fixture.bucket.objects.get("o/p/abc")?.size).toBe(5);
        fixture.setRecheckFailure(false);
        const newerId = await create(fixture.serve);
        const newerPath = `/v8/x/uploads/${newerId}`;
        const newerPart = await fixture.serve(`${newerPath}/parts/1`, "PUT", "write", "world", {
          "content-length": "5",
        });
        expect(
          (
            await fixture.serve(
              `${newerPath}/complete`,
              "POST",
              "write",
              JSON.stringify({ parts: [await newerPart.json()] }),
            )
          ).status,
        ).toBe(202);
        expect((await fixture.serve(`${path}/complete`, "POST", "write", manifest)).status).toBe(
          503,
        );
        expect(new TextDecoder().decode(fixture.bucket.objects.get("o/p/abc")?.bytes)).toBe(
          "world",
        );
      });
      const rows = yield* db.query("test.ledger", (q) => q.select().from(schema.artifactUsage));
      expect(rows.map((r) => r.bytes)).toEqual([5]);
      const status = yield* quotas.status({ orgId: "o", projectId: "p" });
      expect(status.project.usage.storageBytes).toBe(5);
      expect(status.project.usage.requests).toBe(2);
    }).pipe(Effect.provide(QuotasTest)),
  );
});

test("abandoned reservation expires before its ticket and cannot publish", async () => {
  let now = 1000000;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1000000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1000000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1000000n),
    sleep: () => Effect.void,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const quotas = yield* Quotas;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "o", slug: "o", name: "O", createdAt: new Date() }),
        q.insert(schema.project).values([
          { id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 },
          { id: "q", orgId: "o", slug: "q", name: "Q", createdAt: 0 },
        ]),
      ]);
      const fixture = multipartFixture(quotas, clock, () => {
        now += 10;
      });
      const id = yield* Effect.promise(() => create(fixture.serve));
      const payload = JSON.parse(Buffer.from(id.split(".")[0]!, "base64url").toString());
      now = payload.expiresAt - 1;
      yield* quotas.reserve({ orgId: "o", projectId: "q" }, "bb", 1);
      yield* Effect.promise(async () => {
        const path = `/v8/x/uploads/${id}`;
        const part = await fixture.serve(`${path}/parts/1`, "PUT", "write", "hello", {
          "content-length": "5",
        });
        expect(part.status).toBe(503);
        expect(fixture.bucket.objects.has("o/p/abc")).toBe(false);
      });
      expect(
        (yield* quotas.status({ orgId: "o", projectId: "p" })).project.usage.storageBytes,
      ).toBe(0);
    }).pipe(Effect.provide(QuotasTest), Effect.provideService(Clock.Clock, clock)),
  );
});

test("multipart POSTs never emit artifact-query accounting", async () => {
  let operations = 0;
  const fixture = multipartFixture(undefined, undefined, undefined, () => operations++);
  const id = await create(fixture.serve);
  const path = `/v8/x/uploads/${id}`;
  expect(
    (await fixture.serve(`${path}/parts/1`, "PUT", "write", "hello", { "content-length": "5" }))
      .status,
  ).toBe(200);
  expect(
    (
      await fixture.serve(
        `${path}/complete`,
        "POST",
        "write",
        '{"parts":[{"partNumber":1,"etag":"etag-1"}]}',
      )
    ).status,
  ).toBe(202);
  const abandoned = await create(fixture.serve);
  expect((await fixture.serve(`/v8/x/uploads/${abandoned}/abort`)).status).toBe(204);
  expect(operations).toBe(0);
  await fixture.serve("/v8/artifacts", "POST", "write", '{"hashes":[]}');
  expect(operations).toBe(1);
});
