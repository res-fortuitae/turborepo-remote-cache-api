/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- HTTP integration boundary over real auth and migrated D1. */
import { AuditPage } from "@repo/api-spec";
import { expect, test } from "bun:test";
import { AuditLog, AuditReaderLive, AuditHistoryDisabled } from "@repo/audit";
import { AuditLogTest } from "@repo/audit/testing";
import { AuthTest } from "@repo/auth/testing";
import { AuthorizationAuditLive } from "@repo/projects";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Effect, Layer, Schema } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { auditRoute } from "../src/audit-route.ts";
import { eq } from "drizzle-orm";

const layer = Layer.mergeAll(
  AuthTest,
  AuditLogTest,
  AuthorizationDatabaseLive.pipe(
    Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogTest))),
  ),
  AuditReaderLive.pipe(Layer.provide(AuditHistoryDisabled)),
).pipe(Layer.provideMerge(DatabaseTest));
const decodePage = Schema.decodeUnknownSync(AuditPage);
const range = "from=2020-01-01T00%3A00%3A00.000Z&to=2099-01-01T00%3A00%3A00.000Z";
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
const call = (path: string, token: string, method = "GET") =>
  Effect.gen(function* () {
    const headers = new Headers();
    if (token) headers.set("cookie", yield* Effect.promise(() => cookie(token)));
    const response = yield* auditRoute.pipe(
      Effect.provideService(
        Request.HttpServerRequest,
        Request.fromWeb(
          new globalThis.Request(`http://localhost${path}?${range}`, { headers, method }),
        ),
      ),
    );
    return Response.toWeb(response);
  });

test("audit HTTP enforces fresh sessions, org read/export grants, instance roles, and audited streaming formats", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const audit = yield* AuditLog;
      const now = new Date();
      yield* db.batch((db) => [
        db.insert(schema.user).values(
          ["owner", "auditor", "outsider", "instance-auditor"].map((id) => ({
            id,
            name: id,
            email: `${id}@example.com`,
            emailVerified: true,
            role: id === "instance-auditor" ? "auditor" : "member",
            createdAt: now,
            updatedAt: now,
          })),
        ),
        db.insert(schema.session).values(
          ["owner", "auditor", "outsider", "instance-auditor"].map((id) => ({
            id: `${id}-session`,
            userId: id,
            token: id,
            expiresAt: new Date(Date.now() + 86400000),
            createdAt: now,
            updatedAt: now,
          })),
        ),
        db.insert(schema.organization).values([
          { id: "org-a", name: "A", slug: "a", createdAt: now },
          { id: "org-b", name: "B", slug: "b", createdAt: now },
        ]),
        db.insert(schema.member).values([
          {
            id: "m-owner",
            organizationId: "org-a",
            userId: "owner",
            role: "owner",
            createdAt: now,
          },
          {
            id: "m-auditor",
            organizationId: "org-a",
            userId: "auditor",
            role: "auditor",
            createdAt: now,
          },
        ]),
      ]);
      for (const orgId of ["org-a", "org-b"])
        yield* audit.commit(
          {
            scope: "org",
            orgId,
            actor: { type: "user", id: "owner", display: "Owner" },
            action: "project.created",
            target: { type: "project", id: "project" },
            outcome: "allow",
            ip: "",
            userAgent: "",
            requestId: "request",
            metadata: {},
          },
          () => [],
        );
      expect((yield* call("/orgs/org-a/audit", "")).status).toBe(401);
      expect((yield* call("/orgs/org-a/audit", "outsider")).status).toBe(403);
      const allowed = yield* call("/orgs/org-a/audit", "auditor");
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      const body = decodePage(yield* Effect.promise(() => allowed.json()));
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.orgId).toBe("org-a");
      expect((yield* call("/orgs/org-b/audit", "auditor")).status).toBe(403);
      expect((yield* call("/instance/audit", "owner")).status).toBe(403);
      expect((yield* call("/instance/audit", "instance-auditor")).status).toBe(200);
      expect((yield* call("/orgs/org-a/audit/export.csv", "auditor")).status).toBe(403);
      const csv = yield* call("/orgs/org-a/audit/export.csv", "owner");
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect(yield* Effect.promise(() => csv.text())).toContain("project.created");
      const jsonl = yield* call("/orgs/org-a/audit/export.jsonl", "owner");
      expect(jsonl.status).toBe(200);
      const lines = (yield* Effect.promise(() => jsonl.text()))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.every((line) => line.orgId === "org-a")).toBe(true);
      const events = yield* db.query("test.exportAudit", (db) =>
        db.select().from(schema.auditEvent),
      );
      expect(events.filter((row) => row.payload.action === "audit.export")).toHaveLength(2);
      expect((yield* call("/orgs/org-a/audit", "owner", "POST")).status).toBe(405);
      yield* db.query("test.revoke", (db) =>
        db.delete(schema.session).where(eq(schema.session.userId, "owner")),
      );
      expect((yield* call("/orgs/org-a/audit", "owner")).status).toBe(401);
    }).pipe(Effect.provide(layer), Effect.scoped),
  ));
