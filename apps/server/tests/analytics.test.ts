/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- HTTP integration over real auth and migrated D1. */
import { expect, test } from "bun:test";
import { AnalyticsQueryLive, AnalyticsDrilldowns } from "@repo/analytics";
import { AuditLogTest } from "@repo/audit/testing";
import { AuthorizationAuditLive } from "@repo/projects";
import { AuthTest } from "@repo/auth/testing";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { Database, schema, ProjectRepoLive } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { analyticsRoute } from "../src/analytics-route.ts";
import { eq } from "drizzle-orm";

const range = "from=2026-10-25T00:00:00.000Z&to=2026-10-26T00:00:00.000Z&granularity=hour";

const cookie = async (token: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );

  return `better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...bytes))}`)}`;
};

const call = (path: string, token: string, filters = range) =>
  Effect.gen(function* () {
    const headers = new Headers();

    if (token) headers.set("cookie", yield* Effect.promise(() => cookie(token)));

    return Response.toWeb(
      yield* analyticsRoute.pipe(
        Effect.provideService(
          Request.HttpServerRequest,
          Request.fromWeb(
            new globalThis.Request(`http://localhost${path}?${filters}`, { headers }),
          ),
        ),
      ),
    );
  });

test("analytics HTTP checks fresh permissions before reading or drilling into tenant data", async () => {
  let drilldowns = 0;

  const layer = Layer.mergeAll(
    AuthTest,
    AuditLogTest,
    AuthorizationDatabaseLive.pipe(
      Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogTest))),
    ),
    ProjectRepoLive,
    AnalyticsQueryLive,
    Layer.succeed(AnalyticsDrilldowns, {
      read: () => {
        drilldowns++;

        return Effect.succeed({ rows: [], generatedAt: new Date().toISOString() });
      },
    }),
  ).pipe(Layer.provideMerge(DatabaseTest));

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const now = new Date();
      const users = ["auditor", "member", "outside", "instance-auditor"];
      yield* db.batch((q) => [
        q.insert(schema.user).values(
          users.map((id) => ({
            id,
            name: id,
            email: `${id}@example.com`,
            emailVerified: true,
            role: id === "instance-auditor" ? "auditor" : "member",
            createdAt: now,
            updatedAt: now,
          })),
        ),
        q.insert(schema.session).values(
          users.map((id) => ({
            id: `${id}-session`,
            userId: id,
            token: id,
            expiresAt: new Date(Date.now() + 86400000),
            createdAt: now,
            updatedAt: now,
          })),
        ),
        q.insert(schema.organization).values([
          { id: "o", name: "O", slug: "o", createdAt: now },
          { id: "foreign", name: "F", slug: "f", createdAt: now },
        ]),
        q.insert(schema.member).values(
          ["auditor", "member"].map((id) => ({
            id: `m-${id}`,
            organizationId: "o",
            userId: id,
            role: id,
            createdAt: now,
          })),
        ),
        q.insert(schema.project).values([
          { id: "p", orgId: "o", name: "P", slug: "p", createdAt: 0 },
          { id: "foreign-p", orgId: "foreign", name: "F", slug: "f", createdAt: 0 },
        ]),
      ]);
      expect((yield* call("/orgs/o/analytics", "")).status).toBe(401);
      expect((yield* call("/orgs/o/analytics", "outside")).status).toBe(403);
      expect((yield* call("/orgs/o/analytics", "member")).status).toBe(403);
      const allowed = yield* call("/orgs/o/analytics", "auditor");
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      expect((yield* call("/projects/p/analytics", "auditor")).status).toBe(200);
      expect((yield* call("/projects/foreign-p/analytics", "auditor")).status).toBe(403);
      expect((yield* call("/instance/analytics", "auditor")).status).toBe(403);
      expect((yield* call("/instance/analytics", "instance-auditor")).status).toBe(200);
      expect((yield* call("/orgs/o/analytics", "auditor", range + "&org_id=foreign")).status).toBe(
        400,
      );

      const filters =
        "from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z&template=most-missed&limit=10";

      expect(
        (yield* call("/projects/foreign-p/analytics/drilldown", "auditor", filters)).status,
      ).toBe(403);
      expect(drilldowns).toBe(0);
      expect((yield* call("/projects/p/analytics/drilldown", "auditor", filters)).status).toBe(200);
      expect(drilldowns).toBe(1);
      // Fresh database role checks must override a previously authorized request.
      yield* db.query("test.revoke", (q) =>
        q.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, "auditor")),
      );
      expect((yield* call("/projects/p/analytics", "auditor")).status).toBe(403);
      yield* db.query("test.ban", (q) =>
        q.update(schema.user).set({ banned: true }).where(eq(schema.user.id, "instance-auditor")),
      );
      expect((yield* call("/instance/analytics", "instance-auditor")).status).toBe(401);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
