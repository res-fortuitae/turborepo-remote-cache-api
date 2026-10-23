import { describe, expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { getAuthTables } from "better-auth/db";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { Auth, AuthError, Unauthenticated } from "./auth.ts";
import { makeBetterAuth } from "./options.ts";
import { SecondaryStorage, SecondaryStorageTest } from "./secondary-storage.ts";
import { AuthTest } from "./testing.ts";

const SECRET = "auth-test-secret-0123456789abcdef0123456789";

const AuthWithKvTest = AuthTest.pipe(Layer.provideMerge(SecondaryStorageTest));

const run = <A, E, R extends Auth | Database | SecondaryStorage>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, unknown> = AuthWithKvTest,
) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- bun:test executes Effects at this test boundary.
  Effect.runPromise(Effect.provide(program, layer));

/** Better Auth's signed session cookie (better-call HMAC-SHA256, base64). */
const sessionCookie = async (token: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return new Headers({
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${encoded}`)}`,
  });
};

const now = () => new Date();

// Better Auth's default session length, so lookups skip the refresh write.
const inSevenDays = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

/** Inserts a user and a live session directly into D1. */
const seedSession = (token: string) =>
  Effect.gen(function* () {
    const database = yield* Database;

    const user = {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: null,
      createdAt: now(),
      updatedAt: now(),
    };

    const session = {
      id: "session-1",
      token,
      userId: user.id,
      expiresAt: inSevenDays(),
      createdAt: now(),
      updatedAt: now(),
      ipAddress: null,
      userAgent: null,
    };

    yield* database.batch((db) => [
      db.insert(schema.user).values(user),
      db.insert(schema.session).values(session),
    ]);

    return { user, session, headers: yield* Effect.promise(() => sessionCookie(token)) };
  });

describe("Auth", () => {
  test("serves Better Auth endpoints under /api/auth", async () => {
    const response = await run(
      Effect.flatMap(Effect.service(Auth), (auth) =>
        auth.handler(new Request("http://localhost/api/auth/ok")),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("has no session without a cookie", async () => {
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const session = yield* auth.getSession(new Headers());
        const error = yield* Effect.flip(auth.requireSession(new Headers()));

        return { session, error };
      }),
    );

    expect(Option.isNone(result.session)).toBe(true);
    expect(result.error).toEqual(new Unauthenticated({ reason: "missing" }));
  });

  test("reads a D1 session without secondary storage", async () => {
    const session = await run(
      Effect.gen(function* () {
        const { headers } = yield* seedSession("token-d1");
        const auth = yield* Auth;

        return yield* auth.requireFreshSession(headers);
      }),
      AuthTest,
    );

    expect(session.user.email).toBe("ada@example.com");
    expect(session.session.token).toBe("token-d1");
  });

  test("falls back to D1 on a cache miss, then rejects a forged cookie", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seedSession("token-miss");
        const auth = yield* Auth;

        const valid = yield* auth.getSession(
          yield* Effect.promise(() => sessionCookie("token-miss")),
        );

        const forged = yield* auth.getSession(
          new Headers({ cookie: "better-auth.session_token=token-miss.forged" }),
        );

        return { valid, forged };
      }),
    );

    expect(Option.map(result.valid, (s) => s.user.id)).toEqual(Option.some("user-1"));
    expect(Option.isNone(result.forged)).toBe(true);
  });

  test("a stale cached session passes requireSession but not requireFreshSession", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { user, session, headers } = yield* seedSession("token-stale");
        const storage = yield* SecondaryStorage;
        const database = yield* Database;
        const auth = yield* Auth;

        // Revoked in D1 while another location's KV still holds the session.
        yield* storage.set(session.token, JSON.stringify({ session, user }), 3600);
        yield* database.query("test.revoke", (db) =>
          db.delete(schema.session).where(eq(schema.session.token, session.token)),
        );

        const cached = yield* auth.requireSession(headers);
        const fresh = yield* Effect.flip(auth.requireFreshSession(headers));

        return { cached, fresh };
      }),
    );

    expect(result.cached.session.token).toBe("token-stale");
    expect(result.fresh).toEqual(new Unauthenticated({ reason: "revoked" }));
  });

  test("revokeSessions removes sessions from D1 and the cache", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { headers } = yield* seedSession("token-revoke");
        const auth = yield* Auth;
        const storage = yield* SecondaryStorage;
        const database = yield* Database;

        yield* auth.requireSession(headers);
        yield* auth.revokeSessions(headers);

        return {
          cached: yield* storage.get("token-revoke"),
          rows: yield* database.query("test.sessions", (db) => db.select().from(schema.session)),
          after: yield* Effect.flip(auth.requireSession(headers)),
        };
      }),
    );

    expect(Option.isNone(result.cached)).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.after).toEqual(new Unauthenticated({ reason: "missing" }));
  });

  test("maps Better Auth API errors to AuthError", async () => {
    const error = await run(
      Effect.flatMap(Effect.service(Auth), (auth) =>
        Effect.flip(auth.revokeSessions(new Headers())),
      ),
    );

    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  test("layer builds are isolated", async () => {
    await run(Effect.asVoid(seedSession("token-isolated")));

    const rows = await run(
      Effect.flatMap(Effect.service(Database), (database) =>
        database.query("test.sessions", (db) => db.select().from(schema.session)),
      ),
    );

    expect(rows).toEqual([]);
  });
});

describe("Better Auth schema", () => {
  test("every table and column Better Auth needs exists in @repo/db", async () => {
    const options = await run(
      Effect.gen(function* () {
        const database = yield* Database;

        return makeBetterAuth({
          config: {
            secret: Redacted.make(SECRET),
            baseURL: "http://localhost",
            trustedOrigins: [],
          },
          db: database.drizzle,
          secondaryStorage: undefined,
        }).options;
      }),
      AuthTest,
    );

    const tables: Record<string, object> = { ...schema };
    const missing: Array<string> = [];

    for (const [model, table] of Object.entries(getAuthTables(options))) {
      const drizzleTable = tables[table.modelName];

      if (drizzleTable === undefined) {
        missing.push(model);
        continue;
      }

      for (const field of Object.keys(table.fields)) {
        if (!(field in drizzleTable)) missing.push(`${model}.${field}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
