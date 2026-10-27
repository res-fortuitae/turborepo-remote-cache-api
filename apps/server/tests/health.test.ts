/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives HTTP adapters at this boundary. */
import { expect, test } from "bun:test";
import { AuthTest, AuthConfigTest } from "@repo/auth/testing";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { CanonicalOrigin } from "@repo/deploy-config";
import { RateLimiterTest } from "@repo/ratelimit";
import { HealthReport, SelfTestReport } from "@repo/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { healthRoute } from "../src/health-route.ts";
import { selftestRoute } from "../src/selftest-route.ts";
import { memoryBucket } from "./support/in-process.ts";

for (const failing of [false, true])
  test(`health reports fixed status with a ${failing ? "failed" : "healthy"} binding`, async () => {
    const response = await Effect.runPromise(
      healthRoute(
        {
          d1: Effect.void,
          r2: failing ? Effect.fail("secret exception text") : Effect.void,
          kv: Effect.void,
          coordinator: Effect.void,
        },
        { analytics: false, auditHistory: false, directUploads: false, emailSending: false },
      ),
    );
    expect(response.status).toBe(failing ? 503 : 200);
    const web = HttpServerResponse.toWeb(response);
    const text = await web.text();
    expect(text).not.toContain("secret exception");
    expect(Schema.decodeUnknownSync(HealthReport)(JSON.parse(text)).healthy).toBe(!failing);
    expect(web.headers.get("cache-control")).toBe("no-store");
  });
const layer = Layer.mergeAll(
  AuthTest,
  AuditLogTest,
  InstanceSettingsRepoLive,
  AuthConfigTest,
  RateLimiterTest,
  Layer.succeed(CanonicalOrigin, "http://localhost"),
).pipe(Layer.provideMerge(DatabaseTest));
test("admin self-test performs the cache flow, audits, and cleans its isolated namespace", async () => {
  const bucket = memoryBucket();
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const now = new Date();
      yield* db.batch((db) => [
        db.insert(schema.user).values({
          id: "owner",
          name: "Owner",
          email: "owner@example.com",
          role: "owner",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "s",
          token: "session",
          userId: "owner",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + 604800000),
        }),
      ]);
      const call = (origin: string) =>
        selftestRoute(bucket).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/api/instance/selftest", {
                method: "POST",
                headers: { authorization: "Bearer session", origin },
              }),
            ),
          ),
        );
      expect((yield* call("https://evil.test")).status).toBe(403);
      const response = yield* call("http://localhost");
      const web = HttpServerResponse.toWeb(response);
      const report = Schema.decodeUnknownSync(SelfTestReport)(
        yield* Effect.promise(() => web.json()),
      );
      expect(report.steps.map((step) => step.name)).toEqual([
        "PUT",
        "HEAD",
        "GET",
        "query",
        "events",
        "delete",
      ]);
      expect(report).toMatchObject({ ok: true });
      expect(response.status).toBe(200);
      expect(bucket.objects.size).toBe(0);
      const audits = yield* db.query("test.audit", (db) => db.select().from(schema.auditEvent));
      expect(audits.some((row) => row.payload.action === "instance.selftest")).toBe(true);
      expect(JSON.stringify(report)).not.toContain("session");
      yield* db.query("test.demote", (db) =>
        db.update(schema.user).set({ role: "member" }).where(eq(schema.user.id, "owner")),
      );
      expect((yield* call("http://localhost")).status).toBe(403);
      yield* db.query("test.promote", (db) =>
        db.update(schema.user).set({ role: "owner" }).where(eq(schema.user.id, "owner")),
      );
      bucket.failing = true;
      const failed = yield* call("http://localhost");
      expect(failed.status).toBe(503);
      const failedReport = Schema.decodeUnknownSync(SelfTestReport)(
        yield* Effect.promise(() => HttpServerResponse.toWeb(failed).json()),
      );
      expect(failedReport.ok).toBe(false);
      expect(failedReport.steps.find((step) => step.name === "delete")?.ok).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});
