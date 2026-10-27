import { AnomaliesTest } from "@repo/artifacts/testing";
import { AuthTest } from "@repo/auth/testing";
import { AuthorizationCeilings } from "@repo/authz";
import { AuthorizationTest } from "@repo/authz/testing";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { anomaliesRoute } from "../src/anomalies-route.ts";
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun entry point exercises migrated SQLite and real Effect layers. */
import { expect, test } from "bun:test";
import { Database, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { AuditLogTest } from "@repo/audit/testing";
import { CoordinatorClient, CoordinatorClientTest, CoordinatorError } from "@repo/coordinator";
import { AnomalyAlerts } from "@repo/artifacts";
import { CanonicalOrigin, defaultInstancePolicy } from "@repo/deploy-config";
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { Anomalies, AnomaliesLive } from "@repo/artifacts";
const tightenedPolicy = {
  ...defaultInstancePolicy,
  allowedEmailDomains: [...defaultInstancePolicy.allowedEmailDomains],
  allowedGithubOrgs: [...defaultInstancePolicy.allowedGithubOrgs],
  allowedOidcIssuers: [...defaultInstancePolicy.allowedOidcIssuers],
  oidcWriteWorkflowRefs: [],
  oidcWriteEnvironments: [],
  requirePasskeyForAdmins: true,
};
const layer = AnomaliesTest;
const seed = Effect.gen(function* () {
  const db = yield* Database;
  yield* db.batch((q) => [
    q.insert(schema.organization).values({ id: "o", name: "O", slug: "o", createdAt: new Date(0) }),
    q.insert(schema.project).values({ id: "p", orgId: "o", slug: "p", name: "P", createdAt: 0 }),
  ]);
});
test("first identity trains; changed workflow alerts, fences writes and revokes existing credentials", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const a = yield* Anomalies,
        db = yield* Database,
        coordinator = yield* CoordinatorClient;
      yield* db.query("test.config", (q) =>
        q
          .insert(schema.anomalyConfig)
          .values({ projectId: "p", readOnlyOnAlert: true, revokeOnAlert: true }),
      );
      expect(yield* a.checkWrite("o", "p", { jobWorkflowRef: "trusted" })).toBe(false);
      expect(yield* a.checkWrite("o", "p", { jobWorkflowRef: "new" })).toBe(true);
      expect(yield* coordinator.revocationEpoch("project:p")).toBe(1);
      yield* a.checkWrite("o", "p", { jobWorkflowRef: "new" });
      expect(yield* coordinator.revocationEpoch("project:p")).toBe(1);
      const incidents = yield* db.query("test.incidents", (q) =>
        q.select().from(schema.anomalyIncident),
      );
      expect(incidents.map((row) => row.code)).toEqual(["first_jobWorkflowRef"]);
      const events = yield* db.query("test.audit", (q) => q.select().from(schema.auditEvent));
      expect(events.some((row) => row.payload.action === "security.anomaly")).toBe(true);
      expect(yield* a.blocked("other-project")).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});
test("hourly checks detect volume, denials and IP diversity; repeated cron does not duplicate incidents", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const a = yield* Anomalies,
        db = yield* Database;
      yield* db.query("test.config", (q) =>
        q.insert(schema.anomalyConfig).values({ projectId: "p", maxExchangeIPs: 2 }),
      );
      yield* a.observe("o", "p", true, "ip1", true);
      yield* a.observe("o", "p", true, "ip2", true);
      yield* a.observe("o", "p", true, "ip3", true);
      const [current] = yield* db.query("test.hour", (q) => q.select().from(schema.anomalyHour));
      if (!current) throw new Error("Missing counter");
      const hour = current.hour - 3_600_000;
      yield* db.batch((q) => [
        q.update(schema.anomalyIdentity).set({ kind: `ip:${hour}` }),
        q.update(schema.anomalyHour).set({ hour, exchanges: 20, denied: 15, writes: 200 }),
        q.insert(schema.anomalyHour).values(
          [1, 2, 3].map((n) => ({
            projectId: "p",
            orgId: "o",
            hour: hour - n * 3_600_000,
            writes: 10,
            checked: true,
          })),
        ),
      ]);
      yield* a.tick;
      yield* a.tick;
      const rows = yield* db.query("test.incidents", (q) =>
        q.select().from(schema.anomalyIncident),
      );
      expect(rows.map((row) => row.code).sort()).toEqual([
        "exchange_denials",
        "exchange_ips",
        "volume_spike",
      ]);
      expect(rows.every((row) => row.delivered)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
test("upload observations detect overwrites, unsigned writes and provider changes without trusting client headers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const a = yield* Anomalies,
        db = yield* Database;
      yield* a.write("o", "p", "hash", 20, true, { provider: "trusted" });
      const [current] = yield* db.query("test.hour", (q) => q.select().from(schema.anomalyHour));
      if (!current) throw new Error("Missing hour");
      yield* db.batch((q) => [
        q.insert(schema.artifactOperation).values({
          id: "previous",
          orgId: "o",
          projectId: "p",
          hash: "hash",
          status: 202,
          createdAt: 0,
          provenance: {},
        }),
        q.insert(schema.anomalyHour).values({
          projectId: "p",
          orgId: "o",
          hour: current.hour - 3_600_000,
          writes: 20,
          signed: 20,
          checked: true,
        }),
      ]);
      yield* a.write("o", "p", "hash", 30, false, { provider: "changed" });
      const rows = yield* db.query("test.incidents", (q) =>
        q.select().from(schema.anomalyIncident),
      );
      expect(rows.map((row) => row.code).sort()).toEqual([
        "first_provider",
        "overwrite",
        "unsigned",
      ]);
      // Default rules alert only, they never silently quarantine a project.
      expect(yield* a.blocked("p")).toBe(false);
      yield* db.query("test.disable", (q) =>
        q.insert(schema.anomalyConfig).values({ projectId: "p", enabled: false }),
      );
      yield* a.write("o", "p", "hash", 30, false, { provider: "another" });
      expect(
        (yield* db.query("test.incidents", (q) => q.select().from(schema.anomalyIncident))).length,
      ).toBe(3);
      const [counter] = yield* db.query("test.counter", (q) =>
        q.select().from(schema.anomalyHour).where(eq(schema.anomalyHour.hour, current.hour)),
      );
      expect(counter?.writes).toBe(2);
    }).pipe(Effect.provide(layer)),
  );
});

test("failed revocation leaves a durable fence until the retry succeeds", async () => {
  let fail = true;
  const coordinatorLayer = Layer.effect(
    CoordinatorClient,
    Effect.gen(function* () {
      const live = yield* CoordinatorClient.pipe(Effect.provide(CoordinatorClientTest));
      return {
        ...live,
        revokeAll: (scope: string) =>
          fail
            ? Effect.fail(new CoordinatorError({ operation: "test", cause: "offline" }))
            : live.revokeAll(scope),
      };
    }),
  );
  const recoveryLayer = AnomaliesLive.pipe(
    Layer.provideMerge(coordinatorLayer),
    Layer.provide(Layer.succeed(AnomalyAlerts, { notify: () => Effect.void })),
    Layer.provide(Layer.succeed(CanonicalOrigin, "https://cache.test")),
    Layer.provideMerge(AuditLogTest),
    Layer.provideMerge(DatabaseTest),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const a = yield* Anomalies,
        db = yield* Database;
      yield* db.query("test.config", (q) =>
        q.insert(schema.anomalyConfig).values({ projectId: "p", revokeOnAlert: true }),
      );
      yield* a.checkWrite("o", "p", { provider: "old" });
      expect((yield* a.checkWrite("o", "p", { provider: "new" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* a.blocked("p")).toBe(true);
      fail = false;
      yield* a.tick;
      expect(yield* a.blocked("p")).toBe(false);
      expect(yield* (yield* CoordinatorClient).revocationEpoch("project:p")).toBe(1);
    }).pipe(Effect.provide(recoveryLayer)),
  );
});

test("management requires authentication, project administration and same-origin mutations", async () => {
  const routeLayer = Layer.mergeAll(
    layer,
    AuthTest,
    AuthorizationTest,
    InstanceSettingsRepoLive.pipe(Layer.provide(layer)),
    Layer.succeed(AuthorizationCeilings, {}),
    Layer.succeed(CanonicalOrigin, "https://cache.test"),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const db = yield* Database;
      const now = new Date(0);
      yield* db.batch((q) => [
        q.insert(schema.user).values({
          id: "u",
          name: "User",
          email: "u@example.com",
          role: "member",
          createdAt: now,
          updatedAt: now,
        }),
        q.insert(schema.session).values({
          id: "s",
          userId: "u",
          token: "token",
          expiresAt: new Date("2099-01-01"),
          createdAt: now,
          updatedAt: now,
        }),
        q
          .insert(schema.member)
          .values({ id: "m", organizationId: "o", userId: "u", role: "owner", createdAt: now }),
      ]);
      const cookie = yield* Effect.promise(async () => {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("token"));
        return `better-auth.session_token=${encodeURIComponent(`token.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
      });
      const serve = (method: string, signed: boolean, origin = "https://cache.test") =>
        anomaliesRoute.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://cache.test/projects/p/anomalies", {
                method,
                headers: {
                  cookie: signed ? cookie : "",
                  origin,
                  "content-type": "application/json",
                },
                body:
                  method === "POST"
                    ? JSON.stringify({
                        enabled: true,
                        readOnlyOnAlert: true,
                        revokeOnAlert: false,
                        minHourlyWrites: 100,
                        volumeMultiplier: 5,
                        maxExchangeIPs: 20,
                        resume: false,
                      })
                    : undefined,
              }),
            ),
          ),
          Effect.map(HttpServerResponse.toWeb),
        );
      expect((yield* serve("GET", false)).status).toBe(401);
      expect((yield* serve("GET", true)).status).toBe(200);
      expect((yield* serve("POST", true, "https://attacker.test")).status).toBe(403);
      expect((yield* serve("POST", true)).status).toBe(200);
      yield* db.batch((q) => [
        q.update(schema.user).set({ role: "admin" }),
        q.insert(schema.orgElevation).values({
          id: "e",
          userId: "u",
          sessionId: "s",
          orgId: "o",
          reason: "test",
          expiresAt: 9999999999999,
        }),
        q.insert(schema.organizationPolicy).values({
          orgId: "o",
          settings: tightenedPolicy,
          updatedAt: 0,
        }),
      ]);
      expect((yield* serve("POST", true)).status).toBe(403);
      yield* db.query("test.proof", (q) =>
        q
          .insert(schema.passkeyProof)
          .values({ sessionId: "s", userId: "u", verifiedAt: Date.now() }),
      );
      expect((yield* serve("POST", true)).status).toBe(200);
      yield* db.query("test.unprove", (q) => q.delete(schema.passkeyProof));
      yield* db.query("test.demote", (q) => q.update(schema.member).set({ role: "member" }));
      expect((yield* serve("POST", true)).status).toBe(403);
    }).pipe(Effect.provide(routeLayer)),
  );
});

test("established UTC hours alert on out-of-hours writes and ignore changing run/commit IDs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const a = yield* Anomalies,
        db = yield* Database;
      yield* a.write("o", "p", "first", 1, true, { provider: "ci" });
      const [current] = yield* db.query("test.hour", (q) => q.select().from(schema.anomalyHour));
      if (!current) throw new Error("Missing hour");
      const nowHour = new Date(current.hour).getUTCHours();
      const previous = Array.from({ length: 24 }, (_, n) => {
        let hour = current.hour - (n + 1) * 3_600_000;
        if (new Date(hour).getUTCHours() === nowHour) hour -= 3_600_000;
        return hour;
      });
      yield* db.query("test.baseline", (q) =>
        q.insert(schema.anomalyHour).values(
          [...new Set(previous)].map((hour) => ({
            orgId: "o",
            projectId: "p",
            hour,
            writes: 1,
            signed: 1,
            checked: true,
          })),
        ),
      );
      // Ensure 24 distinct prior active hours while excluding the current UTC hour.
      yield* db.query("test.extra", (q) =>
        q
          .insert(schema.anomalyHour)
          .values({
            orgId: "o",
            projectId: "p",
            hour: current.hour - 27 * 3_600_000,
            writes: 1,
            signed: 1,
            checked: true,
          })
          .onConflictDoNothing(),
      );
      yield* a.write("o", "p", "second", 1, true, {
        provider: "ci",
        ...{ commitSha: "new", runId: "new" },
      });
      const rows = yield* db.query("test.incidents", (q) =>
        q.select().from(schema.anomalyIncident),
      );
      expect(rows.map((row) => row.code)).toEqual(["unusual_hour"]);
    }).pipe(Effect.provide(layer)),
  );
});

test("anomaly delivery includes comma-separated administrator roles and excludes ordinary members", async () => {
  const recipients: string[] = [];
  const deliveryLayer = AnomaliesLive.pipe(
    Layer.provide(CoordinatorClientTest),
    Layer.provide(
      Layer.succeed(AnomalyAlerts, {
        notify: (alert) =>
          Effect.sync(() => {
            recipients.push(alert.userId);
          }),
      }),
    ),
    Layer.provide(Layer.succeed(CanonicalOrigin, "https://cache.test")),
    Layer.provide(AuditLogTest),
    Layer.provideMerge(DatabaseTest),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      const db = yield* Database;
      yield* db.batch((q) => [
        q.insert(schema.user).values(
          ["admin", "member"].map((id) => ({
            id,
            name: id,
            email: `${id}@example.com`,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          })),
        ),
        q.insert(schema.member).values([
          {
            id: "admin-member",
            userId: "admin",
            organizationId: "o",
            role: "custom, admin",
            createdAt: new Date(0),
          },
          {
            id: "ordinary",
            userId: "member",
            organizationId: "o",
            role: "member",
            createdAt: new Date(0),
          },
        ]),
      ]);
      const anomalies = yield* Anomalies;
      yield* anomalies.checkWrite("o", "p", { provider: "old" });
      yield* anomalies.checkWrite("o", "p", { provider: "new" });
      yield* anomalies.tick;
      yield* anomalies.tick;
      expect(recipients).toEqual(["admin"]);
    }).pipe(Effect.provide(deliveryLayer)),
  );
});
