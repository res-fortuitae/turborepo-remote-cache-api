import { Alerts, type Alert } from "@repo/mailer";
import { apiKeyDigestJob } from "./api-key-digest.ts";
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun integration test boundary. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { defaultInstancePolicy } from "@repo/deploy-config";
import { defaultKeyHasher } from "@better-auth/api-key";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { Auth } from "./auth.ts";
import { ApiKeyLookup, ApiKeyEpochs, ApiKeyBackground } from "./api-keys.ts";
import { AuthConfigTest, AuthTest } from "./testing.ts";
import { SecondaryStorage, SecondaryStorageTest } from "./secondary-storage.ts";

const createdKey = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, key: Schema.String }),
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
const testLayer = (background: "record" | "throw" | "none" = "record") => {
  const epochs = new Map<string, number>();
  const pending: Promise<void>[] = [];
  const runner =
    background === "none"
      ? Layer.empty
      : Layer.succeed(ApiKeyBackground, {
          run: (task) => {
            // Mirrors a Worker execution context read outside its request handler.
            if (background === "throw") throw new Error("outside request handler");
            pending.push(task);
          },
        });
  return {
    epochs,
    pending,
    layer: AuthTest.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SecondaryStorageTest,
          Layer.succeed(ApiKeyEpochs, {
            read: (scope) => Effect.sync(() => epochs.get(scope) ?? 0),
            bump: (scope) =>
              Effect.sync(() => {
                const value = (epochs.get(scope) ?? 0) + 1;
                epochs.set(scope, value);
                return value;
              }),
          }),
          runner,
        ),
      ),
    ),
  };
};
const fixture = Effect.gen(function* () {
  const database = yield* Database;
  const auth = yield* Auth;
  const lookup = yield* ApiKeyLookup;
  const now = new Date("2026-01-01T00:00:00Z");
  yield* database.batch((db) => [
    db.insert(schema.user).values(
      ["owner", "member", "outsider"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    db.insert(schema.session).values(
      ["owner", "member", "outsider"].map((id) => ({
        id,
        userId: id,
        token: id,
        expiresAt: new Date("2099-01-01"),
        createdAt: now,
        updatedAt: now,
      })),
    ),
    db.insert(schema.organization).values({ id: "org", slug: "org", name: "Org", createdAt: now }),
    db.insert(schema.member).values(
      ["owner", "member"].map((id) => ({
        id,
        userId: id,
        organizationId: "org",
        role: id,
        createdAt: now,
      })),
    ),
    db.insert(schema.project).values([
      { id: "project", orgId: "org", slug: "web", name: "Web", createdAt: 1 },
      { id: "other", orgId: "elsewhere", slug: "web", name: "Web", createdAt: 1 },
    ]),
  ]);
  const cookies = new Map<string, string>();
  for (const id of ["owner", "member", "outsider"])
    cookies.set(id, yield* Effect.promise(() => cookie(id)));
  const post = (path: string, body: object, user = "owner", origin = "http://localhost") =>
    auth.handler(
      new Request(`http://localhost/api/auth/${path}`, {
        method: "POST",
        headers: { cookie: cookies.get(user) ?? "", origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const create = (body: object = {}, user = "owner") =>
    post(
      "cache-keys/create",
      { organizationId: "org", name: "CI", permissions: { project: ["project"] }, ...body },
      user,
    );
  return { database, auth, lookup, post, create };
});

test("keys are scoped, hashed, shown once, org-owned, and verification never updates plugin counters", async () => {
  const state = testLayer();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { database, lookup, post, create } = yield* fixture;
      const response = yield* create();
      expect(response.status).toBe(200);
      expect(response.headers.get("Warning")).toContain("less secure");
      const key = yield* Effect.promise(async () => createdKey(await response.json()));
      expect(key.key.startsWith("tcache_")).toBe(true);
      for (let i = 0; i < 3; i++) {
        const verified = yield* lookup.verify(key.key);
        expect(verified.orgId).toBe("org");
        expect(verified.projectId).toBe("project");
        expect(verified.scope).toBe("read");
      }
      yield* Effect.promise(() => Promise.all(state.pending));
      expect(state.pending).toHaveLength(1);
      const rows = yield* database.query("test.keys", (db) => db.select().from(schema.apikey));
      expect(rows[0]?.key).not.toBe(key.key);
      expect(rows[0]?.referenceId).toBe("org");
      expect(rows[0]?.lastRequest).toBeNull();
      expect(rows[0]?.remaining).toBeNull();
      expect(rows[0]?.rateLimitEnabled).toBe(false);
      expect(rows[0]?.requestCount).toBe(0);
      const listed = yield* post("cache-keys/list", { organizationId: "org" });
      expect(yield* Effect.promise(() => listed.text())).not.toContain(key.key);
      yield* database.query("test.departure", (db) =>
        db.delete(schema.member).where(eq(schema.member.userId, "owner")),
      );
      expect((yield* lookup.verify(key.key)).id).toBe(key.id);
    }).pipe(Effect.provide(state.layer)),
  );
});

test("usage sampling never rejects a valid key and records usage without a background runner", async () => {
  for (const background of ["throw", "none"] as const) {
    const state = testLayer(background);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { database, lookup, create } = yield* fixture;
        const response = yield* create();
        const key = yield* Effect.promise(async () => createdKey(await response.json()));

        // The first verification of each minute takes the sampling path.
        expect((yield* lookup.verify(key.key)).id).toBe(key.id);
        expect((yield* lookup.verify(key.key)).id).toBe(key.id);
        const [stamp] = yield* database.query("test.usage", (db) =>
          db.select().from(schema.cacheApiKey),
        );

        // The conditional update has already started when the runner fails.
        expect(stamp?.lastUsedAt).not.toBeNull();
      }).pipe(Effect.provide(state.layer)),
    );
  }
});

test("creation rejects invalid scope, project, expiry, untrusted origin, and unauthorized callers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { create, post } = yield* fixture;
      for (const p of [[], ["project", "other"], ["other"], ["missing"]])
        expect((yield* create({ permissions: { project: p } })).status).toBe(
          p.length === 1 ? 403 : 400,
        );
      for (const cache of [[], ["write"], ["read", "read"], ["admin"]])
        expect((yield* create({ permissions: { project: ["project"], cache } })).status).toBe(400);
      for (const expiresIn of [0, -1, null, 91 * 86400, 31 * 86400])
        expect((yield* create({ expiresIn })).status).toBe(400);
      expect((yield* create({}, "member")).status).toBe(403);
      expect((yield* create({}, "outsider")).status).toBe(403);
      expect((yield* post("cache-keys/create", {}, "owner", "https://evil.example")).status).toBe(
        403,
      );
      expect((yield* post("api-key/create", {})).status).toBe(404);
      expect((yield* post("api-key/update", {})).status).toBe(404);
      expect(
        (yield* create({ permissions: { project: ["project"], cache: ["read", "write"] } })).status,
      ).toBe(200);
    }).pipe(Effect.provide(testLayer().layer)),
  );
});

test("normal revocation evicts KV, emergency revocation rejects stale KV project keys", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { create, post, lookup } = yield* fixture;
      const storage = yield* SecondaryStorage;
      const aResponse = yield* create();
      const bResponse = yield* create();
      const a = yield* Effect.promise(async () => createdKey(await aResponse.json()));
      const b = yield* Effect.promise(async () => createdKey(await bResponse.json()));
      yield* lookup.verify(a.key);
      yield* lookup.verify(b.key);
      const hash = yield* Effect.promise(() => defaultKeyHasher(b.key));
      const cached = yield* storage.get(`cache-key:${hash}`);
      expect((yield* post("cache-keys/revoke", { keyId: a.id }, "outsider")).status).toBe(403);
      expect((yield* post("cache-keys/revoke", { keyId: a.id })).status).toBe(200);
      expect((yield* Effect.result(lookup.verify(a.key)))._tag).toBe("Failure");
      expect((yield* lookup.verify(b.key)).id).toBe(b.id);
      expect((yield* post("cache-keys/revoke", { keyId: b.id, emergency: true })).status).toBe(200);
      if (Option.isSome(cached)) yield* storage.set(`cache-key:${hash}`, cached.value, 60);
      expect((yield* Effect.result(lookup.verify(b.key)))._tag).toBe("Failure");
      const cResponse = yield* create();
      const c = yield* Effect.promise(async () => createdKey(await cResponse.json()));
      expect((yield* lookup.verify(c.key)).projectEpoch).toBe(1);
    }).pipe(Effect.provide(testLayer().layer)),
  );
});

test("instance disallow and expiry are enforced at verification and issuance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { create, database, lookup } = yield* fixture;
      const storage = yield* SecondaryStorage;
      const response = yield* create();
      const key = yield* Effect.promise(async () => createdKey(await response.json()));
      yield* lookup.verify(key.key);
      yield* database.query("test.policy", (db) =>
        db.insert(schema.instanceSettings).values({
          id: 1,
          schemaVersion: 1,
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [],
            apiKeys: "disallowed",
          },
          updatedAt: 1,
        }),
      );
      yield* storage.delete("cache-key-policy:org");
      expect((yield* create()).status).toBe(403);
      expect((yield* Effect.result(lookup.verify(key.key)))._tag).toBe("Failure");
      for (const raw of ["invalid", "tcache_not-a-key", "ey.jwt.token"])
        expect((yield* Effect.result(lookup.verify(raw)))._tag).toBe("Failure");
      yield* database.query("test.reset", (db) => db.delete(schema.instanceSettings));
      yield* storage.delete("cache-key-policy:org");
      const hash = yield* Effect.promise(() => defaultKeyHasher(key.key));
      yield* storage.delete(`cache-key:${hash}`);
      yield* database.query("test.expire", (db) =>
        db
          .update(schema.apikey)
          .set({ expiresAt: new Date("2000-01-01") })
          .where(eq(schema.apikey.id, key.id)),
      );
      expect((yield* Effect.result(lookup.verify(key.key)))._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer().layer)),
  );
});

test("owner digest reports expiring and unused keys without disclosing secrets", async () => {
  const notifications: Alert[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const { create, database } = yield* fixture;
      const response = yield* create({ expiresIn: 86400 });
      const key = yield* Effect.promise(async () => createdKey(await response.json()));
      yield* apiKeyDigestJob;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.userId).toBe("owner");
      expect(notifications[0]?.detail).toContain(key.id);
      expect(JSON.stringify(notifications)).not.toContain(key.key);
      yield* database.query("test.disable", (db) =>
        db.update(schema.apikey).set({ enabled: false }),
      );
      yield* apiKeyDigestJob;
      expect(notifications).toHaveLength(1);
      const unusedResponse = yield* create();
      const unused = yield* Effect.promise(async () => createdKey(await unusedResponse.json()));
      yield* database.query("test.unused", (db) =>
        db
          .update(schema.apikey)
          .set({ createdAt: new Date("2000-01-01") })
          .where(eq(schema.apikey.id, unused.id)),
      );
      yield* apiKeyDigestJob;
      expect(notifications).toHaveLength(2);
      expect(notifications[1]?.detail).toContain(unused.id);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer().layer,
          AuthConfigTest,
          Layer.succeed(Alerts, {
            notify: (alert) =>
              Effect.sync(() => {
                notifications.push(alert);
              }),
          }),
        ),
      ),
    ),
  );
});
