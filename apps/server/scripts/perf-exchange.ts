// Real exchange services over migrated SQLite with a deterministic in-memory JWKS transport.
import { AuditLogD1Only } from "@repo/audit";
import { CacheTokensTest, DpopVerifierLive, ExchangeAnomalies } from "@repo/credentials";
import {
  Database,
  ProjectRepoLive,
  TrustPolicyRepoLive,
  InstanceSettingsRepoLive,
  ReplayGuardLive,
  schema,
} from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin, OidcAudience } from "@repo/deploy-config";
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
import { ExchangeRateLimiter } from "@repo/ratelimit";
import { CoordinatorClientTest } from "@repo/coordinator";
import { Alerts } from "@repo/mailer";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Anomalies, AnomaliesLive } from "../src/anomalies.ts";
const api = "https://benchmark.invalid",
  issuer = GITHUB_ACTIONS_ISSUER;
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "benchmark", alg: "RS256" };
const network = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          request.url.endsWith("openid-configuration")
            ? { issuer, jwks_uri: `${issuer}/keys` }
            : { keys: [jwk] },
        ),
      ),
    ),
  ),
);
const origin = Layer.mergeAll(
  Layer.succeed(CanonicalOrigin, api),
  Layer.succeed(OidcAudience, [api]),
);
const anomalyLayer = AnomaliesLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      AuditLogD1Only,
      CoordinatorClientTest,
      Layer.succeed(Alerts, { notify: () => Effect.void }),
      origin,
    ),
  ),
);
const exchangeLayer = OidcExchangeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CacheTokensTest,
      DpopVerifierLive.pipe(Layer.provide(ReplayGuardLive)),
      AuditLogD1Only,
      ProjectRepoLive,
      TrustPolicyRepoLive,
      InstanceSettingsRepoLive,
      ExchangeConfigLive,
      TrustPolicyMatcherLive,
      PolicyGuardrailsLive,
      Layer.effect(
        ExchangeAnomalies,
        Effect.map(Anomalies, (a) => ({ checkWrite: a.checkWrite, observe: a.observe })),
      ).pipe(Layer.provide(anomalyLayer)),
      OidcVerifierLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            network,
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
      Layer.succeed(ExchangeRateLimiter, { allow: () => Effect.succeed(true) }),
      origin,
    ),
  ),
  Layer.provideMerge(DatabaseTest),
  Layer.provide(origin),
);
const tokens = await Promise.all(
  Array.from({ length: 120 }, () =>
    new SignJWT({
      repository_id: "1",
      repository_owner_id: "2",
      event_name: "push",
      ref: "refs/heads/main",
      job_workflow_ref: "org/repo/.github/workflows/build.yml@refs/heads/main",
    })
      .setProtectedHeader({ alg: "RS256", kid: "benchmark" })
      .setIssuer(issuer)
      .setAudience(api)
      .setSubject("repo:org/repo:ref:refs/heads/main")
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("10m")
      .sign(keys.privateKey),
  ),
);
await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* Database,
      exchange = yield* OidcExchange;
    yield* db.batch((q) => [
      q
        .insert(schema.organization)
        .values({ id: "o", slug: "o", name: "Benchmark", createdAt: new Date(0) }),
      q
        .insert(schema.project)
        .values({ id: "p", orgId: "o", slug: "p", name: "Benchmark", createdAt: 0 }),
      q.insert(schema.trustPolicy).values({
        id: "policy",
        projectId: "p",
        provider: "github",
        createdBy: "benchmark",
        createdAt: 0,
        body: {
          issuer,
          claims: {
            aud: [api],
            repository_id: ["1"],
            repository_owner_id: ["2"],
            event_name: ["push"],
          },
          scope: "read write",
          ttlSeconds: 600,
        },
      }),
    ]);
    const timings: number[] = [];
    for (let n = 0; n < tokens.length; n++) {
      const start = performance.now();
      yield* exchange.exchange(
        { token: tokens[n]!, team: "o", project: "p" },
        { ip: "127.0.0.1", userAgent: "benchmark", requestId: crypto.randomUUID() },
      );
      if (n >= 20) timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
    console.log(
      JSON.stringify(
        {
          samples: timings.length,
          warmup: 20,
          wallP95Ms: p95,
          targetMs: 300,
          runtime: Bun.version,
          platform: `${process.platform}-${process.arch}`,
          scope:
            "Real cached-JWKS OIDC verifier, replay/policy/audit/anomaly services, SQLite test D1 and in-memory Coordinator; no deployed network or Workers CPU",
        },
        null,
        2,
      ),
    );
    if (p95 >= 300) throw new Error("Local OIDC performance budget exceeded");
  }).pipe(Effect.provide(exchangeLayer)),
);
