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
