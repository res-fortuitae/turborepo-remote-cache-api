/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { Effect, Schema } from "effect";
import { Auth } from "./auth.ts";
import { AuthTest, authTestWithSettings } from "./testing.ts";

const responseOrg = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));
const invitationResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    invitation: Schema.Struct({ id: Schema.String }),
    url: Schema.String,
    delivered: Schema.Boolean,
  }),
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
const seed = (id: string, role = "member") =>
  Effect.gen(function* () {
    const db = yield* Database;
    const now = new Date();
    yield* db.batch((db) => [
      db.insert(schema.user).values({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        role,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(schema.session).values({
        id: `${id}-session`,
        userId: id,
        token: id,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    return new Headers({
      cookie: yield* Effect.promise(() => cookie(id)),
      origin: "http://localhost",
      "content-type": "application/json",
    });
  });
const post = (auth: typeof Auth.Service, headers: Headers, path: string, body: Schema.JsonObject) =>
  auth.handler(
    new Request(`http://localhost/api/auth/organization/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );

test("CLI bearer sessions can create and list organizations through the HTTP handler", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      yield* seed("cli-owner", "owner");
      const headers = new Headers({
        authorization: "Bearer cli-owner",
        origin: "http://localhost",
        "content-type": "application/json",
      });
      expect((yield* post(auth, headers, "create", { name: "CLI", slug: "cli" })).status).toBe(200);
      const response = yield* auth.handler(
        new Request("http://localhost/api/auth/organization/list", { headers }),
      );
      expect(response.status).toBe(200);
      const organizations = yield* Effect.promise(() => response.json());
      expect(organizations).toMatchObject([{ slug: "cli" }]);
      headers.set("authorization", "Bearer invalid-session");
      expect(
        (yield* auth.handler(
          new Request("http://localhost/api/auth/organization/list", { headers }),
        )).status,
      ).toBe(401);
      headers.set("authorization", "Bearer cli-owner");
      const db = yield* Database;
      yield* db.query("test.revokeCliSession", (db) => db.delete(schema.session));
      expect(
        (yield* auth.handler(
          new Request("http://localhost/api/auth/organization/list", { headers }),
        )).status,
      ).toBe(401);
    }).pipe(Effect.provide(AuthTest)),
  ));

test("org creation policy, immutable slug, signed recipient-bound single-use invitations", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const owner = yield* seed("owner", "owner");
      const member = yield* seed("member");
      const outsider = yield* seed("outsider");
      expect((yield* post(auth, member, "create", { name: "Denied", slug: "denied" })).status).toBe(
        403,
      );
      const response = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      expect(response.status).toBe(200);
      const org = yield* Effect.promise(async () => responseOrg(await response.json()));
      expect(
        (yield* post(auth, owner, "update", { organizationId: org.id, data: { slug: "new-name" } }))
          .status,
      ).toBe(400);
      const invited = yield* post(auth, owner, "invite", {
        organizationId: org.id,
        email: "member@example.com",
      });
      expect(invited.status).toBe(200);
      const data = yield* Effect.promise(async () => invitationResponse(await invited.json()));
      const signature =
        new URLSearchParams(new URL(data.url).hash.split("?")[1]).get("signature") ?? "";
      const body = { invitationId: data.invitation.id, signature };
      expect((yield* post(auth, outsider, "accept-signed-invitation", body)).status).toBe(403);
      expect((yield* post(auth, member, "accept-invitation", body)).status).toBe(403);
      expect((yield* post(auth, member, "accept-signed-invitation", body)).status).toBe(200);
      expect((yield* post(auth, member, "accept-signed-invitation", body)).status).toBe(403);
      const db = yield* Database;
      const members = yield* db.query("test.members", (db) => db.select().from(schema.member));
      expect(members.filter((m) => m.userId === "member")).toHaveLength(1);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("invitation sending is limited per org and inviter", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const owner = yield* seed("owner", "owner");
      const created = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      const org = yield* Effect.promise(async () => responseOrg(await created.json()));
      for (let i = 0; i < 10; i++)
        expect(
          (yield* post(auth, owner, "invite", {
            organizationId: org.id,
            email: `user${i}@example.com`,
          })).status,
        ).toBe(200);
      expect(
        (yield* post(auth, owner, "invite", { organizationId: org.id, email: "last@example.com" }))
          .status,
      ).toBe(429);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("concurrent acceptance consumes an invitation once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const owner = yield* seed("owner", "owner");
      const member = yield* seed("member");
      const created = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      const org = yield* Effect.promise(async () => responseOrg(await created.json()));
      const invited = yield* post(auth, owner, "invite", {
        organizationId: org.id,
        email: "member@example.com",
      });
      const data = yield* Effect.promise(async () => invitationResponse(await invited.json()));
      const signature =
        new URLSearchParams(new URL(data.url).hash.split("?")[1]).get("signature") ?? "";
      const body = { invitationId: data.invitation.id, signature };
      const responses = yield* Effect.all(
        [
          post(auth, member, "accept-signed-invitation", body),
          post(auth, member, "accept-signed-invitation", body),
        ],
        { concurrency: "unbounded" },
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      const db = yield* Database;
      const members = yield* db.query("test.members", (db) => db.select().from(schema.member));
      expect(members.filter((member) => member.userId === "member")).toHaveLength(1);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("groups are optional, role-free, scoped to org members, and respect configured limits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const db = yield* Database;
      const owner = yield* seed("owner", "owner");
      yield* seed("outsider");
      const created = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      const org = yield* Effect.promise(async () => responseOrg(await created.json()));
      expect(yield* db.query("test.groups", (db) => db.select().from(schema.team))).toEqual([]);
      const groupResponse = yield* post(auth, owner, "create-team", {
        organizationId: org.id,
        name: "frontend-core",
      });
      expect(groupResponse.status).toBe(200);
      const group = yield* Effect.promise(async () => responseOrg(await groupResponse.json()));
      expect(
        (yield* post(auth, owner, "create-team", { organizationId: org.id, name: "another" }))
          .status,
      ).toBe(400);
      expect(
        (yield* post(auth, owner, "add-team-member", { teamId: group.id, userId: "outsider" }))
          .status,
      ).toBe(400);
      expect(
        (yield* post(auth, owner, "add-team-member", { teamId: group.id, userId: "owner" })).status,
      ).toBe(200);
      const [member] = yield* db.query("test.group-members", (db) =>
        db.select().from(schema.teamMember),
      );
      expect(member).not.toHaveProperty("role");
      expect(
        (yield* post(auth, owner, "remove-team", { organizationId: org.id, teamId: group.id }))
          .status,
      ).toBe(200);
    }).pipe(
      Effect.provide(authTestWithSettings({ groups: { maxGroups: 1, maxMembersPerGroup: 1 } })),
    ),
  );
});

test("org members can read any group's members; outsiders and other orgs cannot", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const db = yield* Database;
      const owner = yield* seed("owner", "owner");
      const member = yield* seed("member");
      const outsider = yield* seed("outsider");
      const orgResponse = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      const org = responseOrg(yield* Effect.promise(() => orgResponse.json()));
      yield* db.query("test.member", (db) =>
        db.insert(schema.member).values({
          id: "m-member",
          organizationId: org.id,
          userId: "member",
          role: "member",
          createdAt: new Date(),
        }),
      );
      const groupResponse = yield* post(auth, owner, "create-team", {
        organizationId: org.id,
        name: "core",
      });
      const group = responseOrg(yield* Effect.promise(() => groupResponse.json()));
      expect(
        (yield* post(auth, owner, "add-team-member", { teamId: group.id, userId: "owner" })).status,
      ).toBe(200);
      const get = (headers: Headers, orgId: string) =>
        auth.handler(
          new Request(
            `http://localhost/api/auth/organization/group-members?organizationId=${orgId}&teamId=${group.id}`,
            { headers },
          ),
        );
      // `member` is not in the group, which native list-team-members would refuse.
      const listed = yield* get(member, org.id);

      expect(listed.status).toBe(200);
      expect(yield* Effect.promise(() => listed.json())).toEqual([
        expect.objectContaining({ teamId: group.id, userId: "owner" }),
      ]);
      expect((yield* get(outsider, org.id)).status).toBe(403);
      expect((yield* get(owner, "another-org")).status).toBeGreaterThanOrEqual(403);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("custom org roles work without conferring instance privileges or exceeding delegator permissions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const db = yield* Database;
      const owner = yield* seed("owner", "owner");
      const inviter = yield* seed("inviter");
      const admin = yield* seed("admin");
      const outsider = yield* seed("outsider", "owner");
      const created = yield* post(auth, owner, "create", { name: "Web", slug: "web" });
      const org = yield* Effect.promise(async () => responseOrg(await created.json()));
      yield* db.batch((db) => [
        db.insert(schema.member).values({
          id: "inviter-member",
          organizationId: org.id,
          userId: "inviter",
          role: "recruiter",
          createdAt: new Date(),
        }),
        db.insert(schema.member).values({
          id: "admin-member",
          organizationId: org.id,
          userId: "admin",
          role: "admin",
          createdAt: new Date(),
        }),
      ]);
      expect(
        (yield* post(auth, owner, "create-role", {
          organizationId: org.id,
          role: "recruiter",
          permission: { invitation: ["create"] },
        })).status,
      ).toBe(200);
      expect(
        (yield* post(auth, outsider, "create-role", {
          organizationId: org.id,
          role: "nope",
          permission: { audit: ["read"] },
        })).status,
      ).toBe(403);
      const escalation = yield* post(auth, admin, "create-role", {
        organizationId: org.id,
        role: "delete-org",
        permission: { organization: ["delete"] },
      });
      expect(escalation.status).not.toBe(200);
      expect(
        (yield* post(auth, inviter, "invite", { organizationId: org.id, email: "new@example.com" }))
          .status,
      ).toBe(200);
      expect(
        (yield* post(auth, inviter, "invite", {
          organizationId: org.id,
          email: "new-admin@example.com",
          role: "admin",
        })).status,
      ).toBe(403);
      expect(
        (yield* post(auth, admin, "transfer-ownership", {
          organizationId: org.id,
          newOwnerId: "admin",
        })).status,
      ).toBe(403);
      expect(
        (yield* post(auth, owner, "transfer-ownership", {
          organizationId: org.id,
          newOwnerId: "admin",
        })).status,
      ).toBe(200);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("members can read their own custom permissions without ac:read or inspecting another organization", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const headers = yield* seed("custom");
      const db = yield* Database;
      yield* db.batch((q) => [
        q
          .insert(schema.organization)
          .values({ id: "own", name: "Own", slug: "own", createdAt: new Date(0) }),
        q.insert(schema.member).values({
          id: "custom-member",
          userId: "custom",
          organizationId: "own",
          role: "manager",
          createdAt: new Date(0),
        }),
        q.insert(schema.organizationRole).values({
          id: "manager-role",
          organizationId: "own",
          role: "manager",
          permission: JSON.stringify({ member: ["update"], project: ["create"] }),
          createdAt: new Date(0),
        }),
      ]);
      const get = (orgId: string, path = "my-permissions") =>
        auth.handler(
          new Request(`http://localhost/api/auth/organization/${path}?organizationId=${orgId}`, {
            headers,
          }),
        );
      const response = yield* get("own");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        role: "manager",
        permissions: { member: ["update"], project: ["create"] },
      });
      expect((yield* get("own", "list-roles")).status).toBe(403);
      expect((yield* get("another")).status).toBe(403);
      yield* db.query("test.remove", (q) => q.delete(schema.member));
      expect((yield* get("own")).status).toBe(403);
    }).pipe(Effect.provide(AuthTest)),
  );
});
