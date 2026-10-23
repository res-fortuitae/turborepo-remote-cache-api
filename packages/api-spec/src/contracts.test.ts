// Bun is the workspace test runner; Effects run only at test boundaries.
/* eslint-disable t3code/no-manual-effect-runtime-in-tests */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiGroup,
  HttpApiTest,
  OpenApi,
} from "effect/http-api";
import {
  Api,
  ApiAuthorization,
  ArtifactQueryRequest,
  ArtifactQueryResponse,
  AuditEvent,
  AuditQuery,
  CacheEvent,
  CacheEvents,
  ExchangeRequest,
  ExchangeResponse,
  Forbidden,
  GrantRequest,
  OidcApi,
  PaginationQuery,
  TrustPolicyRequest,
} from "./index.ts";

const decodeArtifactQueryRequest = Schema.decodeUnknownSync(ArtifactQueryRequest);

const decodeArtifactQueryResponse = Schema.decodeUnknownSync(ArtifactQueryResponse);

const decodeAuditEvent = Schema.decodeUnknownSync(AuditEvent);

const decodeAuditQuery = Schema.decodeUnknownSync(AuditQuery);

const decodeCacheEvent = Schema.decodeUnknownSync(CacheEvent);

const decodeCacheEvents = Schema.decodeUnknownSync(CacheEvents);

const decodeExchangeRequest = Schema.decodeUnknownSync(ExchangeRequest);

const decodeExchangeResponse = Schema.decodeUnknownSync(ExchangeResponse);

const decodeGrantRequest = Schema.decodeUnknownSync(GrantRequest);

const decodePaginationQuery = Schema.decodeUnknownSync(PaginationQuery);

const decodeTrustPolicyRequest = Schema.decodeUnknownSync(TrustPolicyRequest);

const encodeAuditEvent = Schema.encodeSync(AuditEvent);

const encodeExchangeResponse = Schema.encodeSync(ExchangeResponse);

const now = "2026-10-23T00:00:00.000Z";

const exchangeResponse = {
  token: "cache-token",
  expiresAt: now,
  api: "https://cache.example.com",
  team: "org-1",
  project: "project-1",
  scope: "read" as const,
  signatureKey: "signature-key",
};

const auditEvent = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ts: now,
  schemaVersion: 1,
  scope: "org",
  orgId: "org-1",
  actor: { type: "user", id: "user-1", display: "User" },
  action: "project.created",
  target: { type: "project", id: "project-1" },
  outcome: "allow",
  ip: "127.0.0.1",
  userAgent: "test",
  requestId: "request-1",
  metadata: { nested: { safe: true }, claims: ["audience"] },
  prevHash: null,
  hash: "digest",
} satisfies typeof AuditEvent.Type;

describe("transport schemas", () => {
  test("cache payloads preserve optional duration and per-hash results", () => {
    const event = {
      sessionId: "",
      source: "REMOTE",
      event: "HIT",
      hash: "deadbeef",
    } satisfies typeof CacheEvent.Type;

    expect(decodeCacheEvents([event])).toEqual([event]);
    expect(decodeCacheEvent({ ...event, duration: 42 }).duration).toBe(42);
    expect(() => decodeCacheEvent({ ...event, source: "other" })).toThrow();
    expect(() => decodeCacheEvent({ ...event, duration: "42" })).toThrow();
    expect(() => decodeArtifactQueryRequest({})).toThrow();
    expect(decodeArtifactQueryRequest({ hashes: ["not-a-hash"] })).toEqual({
      hashes: ["not-a-hash"],
    });

    const response = {
      deadbeef: { size: 12, taskDurationMs: 42, tag: "tag" },
      cafe: null,
      invalid: { error: { message: "Invalid hash" } },
    };

    expect(decodeArtifactQueryResponse(response)).toEqual(response);
  });

  test("OIDC secrets redact in memory and encode back to the specified wire shape", () => {
    const request = decodeExchangeRequest({
      token: "oidc-token",
      team: "org-1",
      project: "project-1",
    });

    expect(Redacted.value(request.token)).toBe("oidc-token");
    expect(String(request.token)).not.toContain("oidc-token");
    const response = decodeExchangeResponse(exchangeResponse);
    expect(Redacted.value(response.token)).toBe("cache-token");
    expect(encodeExchangeResponse(response)).toEqual(exchangeResponse);
    expect(() => decodeExchangeResponse({ ...exchangeResponse, scope: "admin" })).toThrow();
  });

  test("admin validates grant roles, provider enums and positive policy TTLs", () => {
    expect(() =>
      decodeGrantRequest({
        principalType: "user",
        principalId: "u",
        role: "owner",
      }),
    ).toThrow();

    const policy = {
      provider: "github",
      enabled: true,
      issuer: "https://token.actions.githubusercontent.com",
      claims: { aud: ["https://cache.example.com"] },
      scope: "read write",
      ttlSeconds: 300,
    } satisfies typeof TrustPolicyRequest.Type;

    expect(decodeTrustPolicyRequest(policy)).toEqual(policy);
    expect(() => decodeTrustPolicyRequest({ ...policy, ttlSeconds: 0 })).toThrow();
    expect(() => decodeTrustPolicyRequest({ ...policy, provider: "unknown" })).toThrow();
  });

  test("audit is versioned and query pagination is bounded", () => {
    const decoded = decodeAuditEvent(auditEvent);
    expect(encodeAuditEvent(decoded)).toEqual(auditEvent);
    expect(() => decodeAuditEvent({ ...auditEvent, schemaVersion: 2 })).toThrow();
    expect(() => decodeAuditEvent({ ...auditEvent, outcome: "success" })).toThrow();
    expect(() => decodeAuditQuery({ from: "yesterday", to: now })).toThrow();
    expect(() => decodeAuditQuery({ from: "2026-02-30T00:00:00Z", to: now })).toThrow();
    expect(() => decodeAuditEvent({ ...auditEvent, id: "not-a-ulid" })).toThrow();

    for (const limit of [0, -1, 101, 1.5]) {
      expect(() => decodePaginationQuery({ limit })).toThrow();
    }
  });
});

test("OpenAPI contains all groups, Turbo methods/statuses and export media types", () => {
  const spec = OpenApi.fromApi(Api);
  expect(Object.keys(Api.groups)).toEqual(["cache", "oidc", "admin", "analytics", "audit"]);
  expect(spec.paths["/v8/artifacts/{hash}"]?.put?.responses?.["202"]).toBeDefined();
  expect(spec.paths["/v8/artifacts/{hash}"]?.head?.responses?.["200"]?.content).toBeUndefined();
  expect(
    spec.paths["/v8/artifacts/{hash}"]?.get?.responses?.["200"]?.content?.[
      "application/octet-stream"
    ],
  ).toBeDefined();
  expect(
    spec.paths["/orgs/{id}/audit/export.csv"]?.get?.responses?.["200"]?.content?.["text/csv"],
  ).toBeDefined();
  expect(
    spec.paths["/instance/audit/export.jsonl"]?.get?.responses?.["200"]?.content?.[
      "application/x-ndjson"
    ],
  ).toBeDefined();

  for (const group of [Api.groups.admin, Api.groups.analytics, Api.groups.audit]) {
    for (const endpoint of Object.values(group.endpoints)) {
      expect(endpoint.middlewares.has(ApiAuthorization)).toBe(true);
    }
  }
});

test("generated client preserves cache streaming bytes, HEAD headers and 202 uploads", async () => {
  const bytes = new Uint8Array([0, 255, 10, 13, 128]);

  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];

  const clientEffect = HttpApiClient.makeWith(Api, {
    baseUrl: "https://cache.example.com",
    httpClient: HttpClient.make((request) =>
      Effect.gen(function* () {
        let body = "";

        if (Predicate.isTagged(request.body, "Stream")) {
          const chunks = yield* Stream.runCollect(request.body.stream).pipe(Effect.orDie);
          body = Array.from(chunks)
            .flatMap((chunk) => [...chunk])
            .join(",");
        }

        requests.push({ method: request.method, url: request.url, headers: request.headers, body });

        const response =
          request.method === "PUT"
            ? Response.json(
                { urls: ["https://cache.example.com/v8/artifacts/deadbeef"] },
                { status: 202 },
              )
            : new Response(request.method === "HEAD" ? null : bytes, {
                headers: {
                  "content-type": "application/octet-stream",
                  "content-length": "5",
                  "x-artifact-duration": "42",
                },
              });

        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* clientEffect;

      const head = yield* client.cache.head({
        params: { hash: "deadbeef" },
        query: { teamId: "org-1" },
      });

      expect(head.headers["content-length"]).toBe("5");
      expect(head.headers["x-artifact-duration"]).toBe("42");
      const download = yield* client.cache.download({ params: { hash: "deadbeef" }, query: {} });
      const chunks = yield* Stream.runCollect(download.body);
      expect(Array.from(chunks).flatMap((chunk) => [...chunk])).toEqual([...bytes]);

      const upload = yield* client.cache.upload({
        params: { hash: "deadbeef" },
        query: {},
        headers: { "content-length": "5", "x-artifact-duration": "42" },
        payload: Stream.make(bytes),
      });

      expect(upload.urls).toEqual(["https://cache.example.com/v8/artifacts/deadbeef"]);
    }),
  );
  expect(requests.map((request) => request.method)).toEqual(["HEAD", "GET", "PUT"]);
  expect(requests[2]?.headers["content-type"]).toBe("application/octet-stream");
  expect(requests[2]?.body).toBe([...bytes].join(","));
});

test("HttpApiBuilder and HttpApiClient round-trip OIDC and tagged failures in memory", async () => {
  const api = HttpApi.make("ExchangeTest").add(OidcApi);

  const live = HttpApiBuilder.group(api, "oidc", (handlers) =>
    handlers.handle("exchange", ({ payload, headers }) => {
      expect(Redacted.value(headers.dpop!)).toBe("proof");

      return payload.project === "denied"
        ? Effect.fail(new Forbidden({ message: "Exchange denied" }))
        : Effect.succeed(decodeExchangeResponse(exchangeResponse));
    }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(api, ["oidc"]);

      const request = {
        payload: { token: Redacted.make("oidc-token"), team: "org-1", project: "project-1" },
        headers: { dpop: Redacted.make("proof") },
      };

      const response = yield* client.oidc.exchange(request);
      expect(Redacted.value(response.token)).toBe("cache-token");

      const error = yield* client.oidc
        .exchange({ ...request, payload: { ...request.payload, project: "denied" } })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Forbidden);
      expect(error._tag).toBe("Forbidden");
    }).pipe(Effect.provide(live), Effect.provide(HttpServer.layerServices), Effect.scoped),
  );
});

test("audit exports stream CSV bytes and typed JSONL through authorization", async () => {
  const api = HttpApi.make("AuditExportTest").add(
    HttpApiGroup.make("audit").add(
      Api.groups.audit.endpoints.exportOrg,
      Api.groups.audit.endpoints.exportOrgJsonl,
    ),
  );

  const csv = new TextEncoder().encode("id,action\n01ARZ3NDEKTSV4RRFFQ69G5FAV,project.created\n");

  const live = HttpApiBuilder.group(api, "audit", (handlers) =>
    handlers
      .handle("exportOrg", () => Effect.succeed(Stream.make(csv)))
      .handle("exportOrgJsonl", () => Effect.succeed(Stream.make(decodeAuditEvent(auditEvent)))),
  );

  let authorized = 0;

  const authorization = Layer.succeed(ApiAuthorization, (effect) =>
    Effect.sync(() => {
      authorized++;
    }).pipe(Effect.andThen(effect)),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(api, ["audit"]);
      const request = { params: { id: "org-1" }, query: { from: now, to: now } };
      const csvStream = yield* client.audit.exportOrg(request);
      const chunks = yield* Stream.runCollect(csvStream);
      expect(Array.from(chunks).flatMap((chunk) => [...chunk])).toEqual([...csv]);
      const jsonlStream = yield* client.audit.exportOrgJsonl(request);
      const events = yield* Stream.runCollect(jsonlStream);
      expect([...events]).toEqual([decodeAuditEvent(auditEvent)]);
    }).pipe(
      Effect.provide(live),
      Effect.provide(authorization),
      Effect.provide(HttpServer.layerServices),
      Effect.scoped,
    ),
  );
  expect(authorized).toBe(2);
});

test("authorization denial returns a typed failure before the admin handler runs", async () => {
  const api = HttpApi.make("AuthorizationTest").add(
    HttpApiGroup.make("admin").add(Api.groups.admin.endpoints.getProject),
  );

  const live = HttpApiBuilder.group(api, "admin", (handlers) =>
    handlers.handle("getProject", () => Effect.die("handler must not run")),
  );

  const authorization = Layer.succeed(ApiAuthorization, () =>
    Effect.fail(new Forbidden({ message: "Permission denied" })),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(api, ["admin"]);

      const error = yield* client.admin
        .getProject({ params: { id: "project-1" } })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Forbidden);
      expect(error.message).toBe("Permission denied");
    }).pipe(
      Effect.provide(live),
      Effect.provide(authorization),
      Effect.provide(HttpServer.layerServices),
      Effect.scoped,
    ),
  );
});
