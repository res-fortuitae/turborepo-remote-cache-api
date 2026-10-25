/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { Effect, Schema } from "effect";
import { eq } from "drizzle-orm";
import { defaultInstancePolicy } from "@repo/deploy-config";
import { Auth } from "./auth.ts";
import { AuthTest } from "./testing.ts";

const decodePolicyResponse = Schema.decodeUnknownSync(
  Schema.Struct({ policy: Schema.Struct({ maxApiKeyLifetimeDays: Schema.Number }) }),
);
const decodeOrgResponse = Schema.decodeUnknownSync(
  Schema.Struct({ organization: Schema.Struct({ id: Schema.String }) }),
);

const cookie = async (token: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));

  return `better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
};

const scenario = (
  role: string,
  task: (
    auth: typeof Auth.Service,
    db: typeof Database.Service,
    headers: Headers,
  ) => Effect.Effect<void, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const auth = yield* Auth;
      const now = new Date();
      yield* db.batch((db) => [
        db.insert(schema.user).values({
          id: "actor",
          name: "Actor",
          email: "actor@example.com",
          role,
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "session",
          userId: "actor",
          token: "token",
          expiresAt: new Date(Date.now() + 86400000),
          createdAt: now,
          updatedAt: now,
        }),
      ]);

      const headers = new Headers({
        cookie: yield* Effect.promise(() => cookie("token")),
        "content-type": "application/json",
        origin: "http://localhost",
      });

      yield* task(auth, db, headers);
    }).pipe(Effect.provide(AuthTest)),
  );

const request = (path: string, headers: Headers, body?: object) =>
  new Request(`http://localhost/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

test("members cannot mutate instance policy or native admin endpoints", () =>
  scenario("member", (auth, _db, headers) =>
    Effect.gen(function* () {
      expect((yield* auth.handler(request("/instance/settings", headers))).status).toBe(403);
      expect(
        (yield* auth.handler(request("/admin/ban-user", headers, { userId: "actor" }))).status,
      ).toBe(403);
    }),
  ));

test("the last owner cannot be demoted; the attempt revokes sessions", () =>
  scenario("owner", (auth, db, headers) =>
    Effect.gen(function* () {
      expect(
        (yield* auth.handler(
          request("/instance/set-role", headers, { userId: "actor", role: "member" }),
        )).status,
      ).toBe(409);

      const [user] = yield* db.query("test.user", (db) =>
        db.select().from(schema.user).where(eq(schema.user.id, "actor")),
      );

      expect(user?.role).toBe("owner");
      expect(yield* db.query("test.sessions", (db) => db.select().from(schema.session))).toEqual(
        [],
      );
    }),
  ));

test("policy writes are audited, validated, and hard-clamped", () =>
  scenario("admin", (auth, db, headers) =>
    Effect.gen(function* () {
      const response = yield* auth.handler(request("/instance/settings", headers));
      const data = yield* Effect.promise(async () => decodePolicyResponse(await response.json()));

      const updated = yield* auth.handler(
        request("/instance/settings", headers, {
          policy: { ...defaultInstancePolicy, ...data.policy, maxApiKeyLifetimeDays: 999 },
        }),
      );

      expect(updated.status).toBe(200);
      expect(
        (yield* Effect.promise(async () => decodePolicyResponse(await updated.json()))).policy
          .maxApiKeyLifetimeDays,
      ).toBe(90);
      expect(
        (yield* db.query("test.audit", (db) => db.select().from(schema.auditEvent))).length,
      ).toBe(1);
    }),
  ));

test("stale role in a signed session cannot grant admin access", () =>
  scenario("owner", (auth, db, headers) =>
    Effect.gen(function* () {
      yield* auth.getSession(headers);
      yield* db.query("test.demote", (db) =>
        db.update(schema.user).set({ role: "member" }).where(eq(schema.user.id, "actor")),
      );
      expect((yield* auth.handler(request("/instance/settings", headers))).status).toBe(403);
    }),
  ));

test("org lifecycle requires an audited session-bound elevation", () =>
  scenario("owner", (auth, db, headers) =>
    Effect.gen(function* () {
      const created = yield* auth.handler(
        request("/instance/orgs/create", headers, { name: "Web", slug: "web", ownerId: "actor" }),
      );

      expect(created.status).toBe(200);
      const { organization } = yield* Effect.promise(async () =>
        decodeOrgResponse(await created.json()),
      );
      const body = { orgId: organization.id, action: "archive", reason: "Support" };
      expect((yield* auth.handler(request("/instance/orgs/manage", headers, body))).status).toBe(
        403,
      );
      expect(
        (yield* auth.handler(
          request("/instance/orgs/elevate", headers, { orgId: organization.id, reason: "Support" }),
        )).status,
      ).toBe(200);
      expect((yield* auth.handler(request("/instance/orgs/manage", headers, body))).status).toBe(
        200,
      );
      expect(
        (yield* db.query("test.audit", (db) =>
          db.select().from(schema.auditEvent).where(eq(schema.auditEvent.orgId, organization.id)),
        )).length,
      ).toBe(2);
    }),
  ));

test("owner impersonation requires a reason and expires within five minutes", () =>
  scenario("owner", (auth, db, headers) =>
    Effect.gen(function* () {
      yield* db.query("test.target", (db) =>
        db.insert(schema.user).values({
          id: "target",
          name: "Target",
          email: "target@example.com",
          role: "member",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      expect(
        (yield* auth.handler(request("/admin/impersonate-user", headers, { userId: "target" })))
          .status,
      ).toBe(403);
      const response = yield* auth.handler(
        request("/admin/impersonate-user", headers, {
          userId: "target",
          reason: "Support investigation",
        }),
      );
      expect(response.status).toBe(200);
      const sessions = yield* db.query("test.impersonation", (db) =>
        db.select().from(schema.session).where(eq(schema.session.userId, "target")),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.impersonatedBy).toBe("actor");
      expect((sessions[0]?.expiresAt.getTime() ?? Infinity) - Date.now()).toBeLessThanOrEqual(
        300000,
      );
    }),
  ));
