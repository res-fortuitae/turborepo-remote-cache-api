/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun HTTP integration boundary. */
import { expect, test } from "bun:test";
import { ExchangeResponse } from "@repo/api-spec";
import { AuditLogD1Only } from "@repo/audit";
import { CacheTokensTest, CacheTokenVerifier } from "@repo/credentials";
import {
  Database,
  ProjectRepoLive,
  TrustPolicyRepoLive,
  InstanceSettingsRepoLive,
  ReplayGuardLive,
  schema,
} from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin, OidcAudience, defaultInstancePolicy } from "@repo/deploy-config";
import {
  OidcExchange,
  OidcExchangeLive,
  ExchangeConfigLive,
  OidcVerifierLive,
  OidcVerifierConfig,
  BuiltinIssuerRegistry,
  JwksCacheTest,
  TrustPolicyMatcherLive,
  PolicyGuardrailsLive,
  GITHUB_ACTIONS_ISSUER,
} from "@repo/oidc";
import { RateLimiter } from "@repo/ratelimit";
import { sql } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { generateKeyPair, exportJWK, SignJWT, decodeJwt, type JWTPayload } from "jose";
import { oidcApi } from "../src/oidc-route.ts";

const issuer = GITHUB_ACTIONS_ISSUER;
const api = "https://cache.test";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "ci", alg: "RS256" };

const token = (extra: JWTPayload = {}, expires = 1120) =>
  Effect.promise(() =>
    new SignJWT({
      repository_id: "1",
      repository_owner_id: "2",
      event_name: "push",
      ref: "refs/heads/main",
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256", kid: "ci" })
      .setIssuer(issuer)
      .setAudience(api)
      .setSubject("repo:org/repo:ref:refs/heads/main")
      .setJti(crypto.randomUUID())
      .setIssuedAt(1000)
      .setNotBefore(1000)
      .setExpirationTime(expires)
      .sign(keys.privateKey),
  );

const policy = {
  issuer,
  claims: { aud: [api], repository_id: ["1"], repository_owner_id: ["2"], event_name: ["push"] },
  scope: "read write" as const,
  ttlSeconds: 600,
};

const network = (issuer: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("openid-configuration")
              ? {
                  issuer,
                  jwks_uri: `${issuer === "https://accounts.google.com" ? "https://www.googleapis.com" : issuer}/keys`,
                }
              : { keys: [jwk] },
          ),
        ),
      ),
    ),
  );

const deps = (issuer: string) =>
  Layer.mergeAll(
    CacheTokensTest,
    AuditLogD1Only,
    ProjectRepoLive,
    TrustPolicyRepoLive,
    InstanceSettingsRepoLive,
    ExchangeConfigLive,
    TrustPolicyMatcherLive,
    PolicyGuardrailsLive,
    OidcVerifierLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          network(issuer),
          BuiltinIssuerRegistry,
          JwksCacheTest,
          ReplayGuardLive,
          Layer.succeed(OidcVerifierConfig, {
            allowedIssuers: [issuer],
            maxTokenAgeSeconds: 600,
            clockSkewSeconds: 30,
          }),
        ),
      ),
    ),
    Layer.succeed(CanonicalOrigin, api),
    Layer.succeed(OidcAudience, [api]),
  );

type Env = Database | CacheTokenVerifier | OidcExchange;

type Serve = (
  body: unknown,
  options?: { raw?: string; dpop?: string; method?: string },
) => Effect.Effect<Response, unknown, OidcExchange>;

const scenario = (
  task: (serve: Serve, limit: (key: string) => void) => Effect.Effect<void, unknown, Env>,
  activeIssuer = issuer,
) => {
  let blocked = "";

  const rate = Layer.succeed(RateLimiter, {
    allow: (key: string) => Effect.succeed(key !== blocked),
  });

  const layer = OidcExchangeLive.pipe(
    Layer.provideMerge(deps(activeIssuer)),
    Layer.provide(rate),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(TestClock.layer()),
    Layer.provide(
      Layer.mergeAll(Layer.succeed(CanonicalOrigin, api), Layer.succeed(OidcAudience, [api])),
    ),
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.adjust(1_000_000);
      const db = yield* Database;
      yield* db.batch((db) => [
        db
          .insert(schema.organization)
          .values({ id: "org", name: "Org", slug: "org", createdAt: new Date(0) }),
        db
          .insert(schema.project)
          .values({ id: "p", orgId: "org", name: "Project", slug: "p", createdAt: 0 }),
        db
          .insert(schema.project)
          .values({ id: "other", orgId: "org", name: "Other", slug: "other", createdAt: 0 }),
        db.insert(schema.trustPolicy).values({
          id: "policy",
          projectId: "p",
          provider: "github",
          body: policy,
          createdBy: "admin",
          createdAt: 0,
        }),
      ]);

      const serve: Serve = (body, options = {}) =>
        oidcApi.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${api}/oidc/exchange`, {
                method: options.method ?? "POST",
                headers: {
                  "cf-connecting-ip": "127.0.0.1",
                  ...(options.dpop === undefined ? {} : { dpop: options.dpop }),
                },
                body: options.method === "GET" ? undefined : (options.raw ?? JSON.stringify(body)),
              }),
            ),
          ),
          Effect.map(HttpServerResponse.toWeb),
        );

      yield* task(serve, (key) => {
        blocked = key;
      });
    }).pipe(Effect.provide(layer)),
  );
};

const body = (token: string, project = "p") => ({ token, team: "org", project });

const auditRows = Effect.gen(function* () {
  const db = yield* Database;

  return yield* db.query("test.audit", (db) => db.select().from(schema.auditEvent));
});

test("exchange verifies CI signature/replay, issues epoch JWT with bounded TTL and audits without secrets", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const ci = yield* token({ extra_secret: "never-audit-me" });
      const response = yield* serve(body(ci));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");

      const result = Schema.decodeUnknownSync(ExchangeResponse)(
        yield* Effect.promise(() => response.json()),
      );

      expect(result).toMatchObject({
        api,
        team: "org",
        project: "p",
        scope: "read write",
        expiresAt: "1970-01-01T00:19:10.000Z",
      });
      const jwt = Redacted.value(result.token);
      const verifier = yield* CacheTokenVerifier;
      expect(yield* verifier.verify(jwt)).toMatchObject({
        org: "org",
        project: "p",
        scope: "read write",
      });
      expect(decodeJwt(jwt).epoch).toEqual({ org: 0, prj: 0 });
      const replay = yield* serve(body(ci));
      expect(replay.status).toBe(403);
      expect(yield* Effect.promise(() => replay.json())).toEqual({
        _tag: "Forbidden",
        code: "forbidden",
        message: "Exchange denied",
      });
      const rows = yield* auditRows;
      expect(rows.map((row) => row.payload.outcome)).toEqual(["allow", "deny"]);
      const recorded = JSON.stringify(rows);
      expect(recorded).not.toContain(ci);
      expect(recorded).not.toContain(jwt);
      expect(recorded).not.toContain("never-audit-me");
      expect(recorded).toContain("verification_replay");
    }),
  ));

test("only requested project policies grant; denials retain closest failed claims", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      expect((yield* serve(body(yield* token(), "other"))).status).toBe(403);
      expect((yield* serve(body(yield* token({ repository_id: "999" })))).status).toBe(403);
      const rows = yield* auditRows;
      expect(JSON.stringify(rows)).toContain("repository_id");
      expect(JSON.stringify(rows)).toContain("closestPolicyId");
    }),
  ));

test("archived project is read-only; deleted projects and archived orgs cannot exchange", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((db) => [db.update(schema.project).set({ archivedAt: 1 })]);
      const archived = yield* serve(body(yield* token()));
      expect(
        Schema.decodeUnknownSync(ExchangeResponse)(yield* Effect.promise(() => archived.json()))
          .scope,
      ).toBe("read");
      yield* db.batch((db) => [
        db.insert(schema.projectDeletion).values({ projectId: "p", orgId: "org", requestedAt: 1 }),
      ]);
      expect((yield* serve(body(yield* token()))).status).toBe(403);
      yield* db.batch((db) => [
        db.insert(schema.orgLifecycle).values({ orgId: "org", archivedAt: 1 }),
      ]);
      expect((yield* serve(body(yield* token(), "other"))).status).toBe(403);
    }),
  ));

test("live guardrails reject weakened identities and binding cannot silently downgrade", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      expect((yield* serve(body(yield* token()), { dpop: "unverified-proof" })).status).toBe(403);
      const db = yield* Database;
      yield* db.batch((db) => [
        db.update(schema.trustPolicy).set({ body: { ...policy, claims: { aud: [api] } } }),
      ]);
      expect((yield* serve(body(yield* token()))).status).toBe(403);
      yield* db.batch((db) => [
        db.update(schema.trustPolicy).set({ body: { ...policy, requireBoundTokens: true } }),
      ]);
      expect((yield* serve(body(yield* token()))).status).toBe(403);
      yield* db.batch((db) => [
        db.insert(schema.instanceSettings).values({
          id: 1,
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [issuer],
            requireArtifactSigning: true,
          },
          schemaVersion: 1,
          updatedAt: 0,
        }),
      ]);
      expect((yield* serve(body(yield* token()))).status).toBe(403);
    }),
  ));

test("IP/org limits, invalid or oversized JSON and methods have safe no-store responses", () =>
  scenario((serve, limit) =>
    Effect.gen(function* () {
      limit("oidc:ip:127.0.0.1");
      expect((yield* serve(body(yield* token()))).status).toBe(429);
      limit("oidc:org:org");
      const org = yield* serve(body(yield* token()));
      expect(org.status).toBe(429);
      expect(org.headers.get("retry-after")).toBe("60");
      limit("");

      for (const raw of ["{broken", "x".repeat(30_000)]) {
        const response = yield* serve({}, { raw });
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }

      expect((yield* serve({}, { method: "GET" })).status).toBe(405);
    }),
  ));

test("overlapping policies choose minimum TTL/read scope; changed write restrictions fail closed", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((db) => [
        db.insert(schema.trustPolicy).values({
          id: "readonly",
          projectId: "p",
          provider: "github",
          body: { ...policy, scope: "read", ttlSeconds: 10 },
          createdBy: "admin",
          createdAt: 0,
        }),
      ]);
      const response = yield* serve(body(yield* token()));

      const result = Schema.decodeUnknownSync(ExchangeResponse)(
        yield* Effect.promise(() => response.json()),
      );

      expect(result.scope).toBe("read");
      expect(result.expiresAt).toBe("1970-01-01T00:16:50.000Z");
      yield* db.batch((db) => [
        db.insert(schema.instanceSettings).values({
          id: 1,
          schemaVersion: 1,
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [issuer],
            oidcWriteWorkflowRefs: ["org/repo/.github/workflows/cache.yml@refs/heads/main"],
          },
          updatedAt: 0,
        }),
        db.update(schema.trustPolicy).set({ enabled: false }),
      ]);
      expect((yield* serve(body(yield* token()))).status).toBe(403);
    }),
  ));

test("audit persistence failure prevents returning credentials", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query("test.breakAudit", (db) => db.run(sql`DROP TABLE audit_event`));
      const response = yield* serve(body(yield* token()));
      expect(response.status).toBe(503);
      const payload = yield* Effect.promise(() => response.json());
      expect(payload).toEqual({
        _tag: "ServiceUnavailable",
        code: "unavailable",
        message: "Exchange unavailable",
      });
    }),
  ));

test("a lower live instance TTL clamps existing policy grants", () =>
  scenario((serve) =>
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch((db) => [
        db.insert(schema.instanceSettings).values({
          id: 1,
          schemaVersion: 1,
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [issuer],
            maxTokenTtlSeconds: 300,
          },
          updatedAt: 0,
        }),
      ]);
      const response = yield* serve(body(yield* token({}, 1600)));
      expect(response.status).toBe(200);

      const result = Schema.decodeUnknownSync(ExchangeResponse)(
        yield* Effect.promise(() => response.json()),
      );

      expect(result.expiresAt).toBe("1970-01-01T00:21:40.000Z");
    }),
  ));

test("Google assertion without jti/nbf exchanges through real policy, signer and redacted audit", () => {
  const google = "https://accounts.google.com";

  return scenario(
    (serve) =>
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.batch((db) => [
          db.insert(schema.instanceSettings).values({
            id: 1,
            schemaVersion: 1,
            updatedAt: 0,
            settings: {
              ...defaultInstancePolicy,
              allowedEmailDomains: [],
              allowedGithubOrgs: [],
              allowedOidcIssuers: [google],
            },
          }),
          db.update(schema.trustPolicy).set({
            provider: "google",
            body: {
              issuer: google,
              claims: { aud: [api], sub: ["123456789"] },
              scope: "read",
              ttlSeconds: 600,
            },
          }),
        ]);
        const ci = yield* Effect.promise(() =>
          new SignJWT({
            iss: google,
            aud: api,
            sub: "123456789",
            iat: 1000,
            exp: 4600,
            custom_secret: "never-persist",
          })
            .setProtectedHeader({ alg: "RS256", kid: "ci" })
            .sign(keys.privateKey),
        );
        const response = yield* serve(body(ci));
        expect(response.status).toBe(200);
        const result = Schema.decodeUnknownSync(ExchangeResponse)(
          yield* Effect.promise(() => response.json()),
        );
        expect(
          yield* (yield* CacheTokenVerifier).verify(Redacted.value(result.token)),
        ).toMatchObject({ org: "org", project: "p", scope: "read" });
        expect((yield* serve(body(ci))).status).toBe(403);
        const rows = yield* auditRows;
        expect(rows[0]?.payload.metadata).toMatchObject({
          claims: { iss: google, sub: "123456789" },
        });
        expect(JSON.stringify(rows)).not.toContain("never-persist");
        expect(JSON.stringify(rows)).not.toContain(ci);
      }),
    google,
  );
});
