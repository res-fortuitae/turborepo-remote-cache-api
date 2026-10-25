/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives the public Effect service at the test boundary. */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { AuthConfig, defaultInstancePolicy } from "@repo/deploy-config";
import { MailerNoop } from "@repo/mailer";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";
import { createEmulator, type Emulator } from "emulate";
import { Auth, AuthLive } from "./auth.ts";

const ORIGIN = "https://cache.test";
const CLIENT_ID = "emulate-github-client";
const CLIENT_SECRET = "emulate-github-secret";
const realFetch = globalThis.fetch;
let github: Emulator;
let restoreFetch = () => {};
const calls: string[] = [];

beforeAll(async () => {
  github = await createEmulator({
    service: "github",
    port: 0,
    seed: {
      github: {
        users: [
          { login: "octocat", name: "Octocat", email: "octocat@example.com" },
          { login: "ada", name: "Ada", email: "ada@example.com" },
        ],
        oauth_apps: [
          {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            name: "Cache OAuth tests",
            redirect_uris: [`${ORIGIN}/api/auth/callback/github`],
          },
        ],
      },
    },
  });

  // Route Better Auth's unchanged GitHub HTTP transport to the local emulator.
  // No provider response is fabricated; all other outbound hosts fail closed.
  const redirectedFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (!["github.com", "api.github.com"].includes(url.hostname)) {
        throw new Error(`Unexpected external request: ${url.origin}`);
      }

      calls.push(url.pathname);
      const target = new URL(url.pathname + url.search, github.url).href;

      const forwarded =
        input instanceof Request
          ? new Request(target, { method: input.method, headers: input.headers, body: input.body })
          : target;

      return realFetch(forwarded, init);
    },
    { preconnect: realFetch.preconnect },
  );

  const transport = spyOn(globalThis, "fetch").mockImplementation(redirectedFetch);
  restoreFetch = () => transport.mockRestore();
});

afterEach(() => {
  github.reset();
  calls.length = 0;
});

afterAll(async () => {
  restoreFetch();
  await github.close();
});

const GithubAuthTest = AuthLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(AuthConfig, {
        secret: Redacted.make("emulate-auth-secret-0123456789abcdef0123456789"),
        baseURL: ORIGIN,
        trustedOrigins: [ORIGIN],
        github: { clientId: CLIENT_ID, clientSecret: Redacted.make(CLIENT_SECRET) },
      }),
      MailerNoop,
      AuditLogTest,
    ),
  ),
  Layer.provideMerge(DatabaseTest),
);

const run = <A, E>(effect: Effect.Effect<A, E, Auth | Database>) =>
  Effect.runPromise(effect.pipe(Effect.provide(GithubAuthTest)));

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const decodeSignIn = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }));

const decodeUser = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.Number, login: Schema.String }),
);

const providerUser = (login: string) =>
  Effect.promise(async () => {
    const response = await realFetch(`${github.url}/users/${login}`);

    return decodeUser(await response.json());
  });

const authorize = Effect.fn("test.authorize")(function* (login: string) {
  const auth = yield* Auth;

  const start = yield* auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
    }),
  );

  expect(start.status).toBe(200);
  const { url } = decodeSignIn(yield* Effect.promise(() => start.json()));
  const authorization = new URL(url);
  expect(authorization.origin).toBe("https://github.com");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
  expect(authorization.searchParams.get("scope")).toContain("user:email");

  const chooser = yield* Effect.promise(() =>
    realFetch(new URL(authorization.pathname + authorization.search, github.url), {
      redirect: "manual",
    }),
  );

  expect(chooser.status).toBe(200);
  expect(yield* Effect.promise(() => chooser.text())).toContain(login);

  const form = new URLSearchParams(authorization.searchParams);
  form.set("login", login);

  const selected = yield* Effect.promise(() =>
    realFetch(`${github.url}/login/oauth/callback`, {
      method: "POST",
      body: form,
      redirect: "manual",
    }),
  );

  expect(selected.status).toBe(302);

  return { url: selected.headers.get("location")!, cookie: cookieHeader(start) };
});

const finish = Effect.fn("test.finish")(function* (login: string) {
  const callback = yield* authorize(login);
  const auth = yield* Auth;

  return yield* auth.handler(new Request(callback.url, { headers: { cookie: callback.cookie } }));
});

test("emulate.dev OAuth creates a secure session and persists the GitHub account identity", async () => {
  await run(
    Effect.gen(function* () {
      const response = yield* finish("octocat");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const cookies = response.headers.getSetCookie();
      expect(cookies.some((cookie) => cookie.includes("__Secure-better-auth.session_token="))).toBe(
        true,
      );
      expect(
        cookies.some(
          (cookie) =>
            cookie.includes("HttpOnly") &&
            cookie.includes("Secure") &&
            cookie.includes("SameSite=Lax"),
        ),
      ).toBe(true);

      const database = yield* Database;

      const accounts = yield* database.query("test.accounts", (db) =>
        db.select().from(schema.account),
      );

      expect(accounts).toHaveLength(1);
      const profile = yield* providerUser("octocat");
      expect(accounts[0]).toMatchObject({
        providerId: "github",
        accountId: String(profile.id),
        githubLogin: "octocat",
        password: null,
      });
      const auth = yield* Auth;

      const session = yield* auth.requireFreshSession(
        new Headers({ cookie: cookieHeader(response) }),
      );

      expect(session.user.email).toBe("octocat@example.com");
      expect(calls).toEqual(["/login/oauth/access_token", "/user", "/user/emails"]);
    }),
  );
});

test("returning GitHub sign-in refreshes stale login metadata without duplicating the account", async () => {
  await run(
    Effect.gen(function* () {
      yield* finish("octocat");
      const database = yield* Database;
      yield* database.query("test.staleLogin", (db) =>
        db
          .update(schema.account)
          .set({ githubLogin: "old-login" })
          .where(eq(schema.account.providerId, "github")),
      );
      const response = yield* finish("octocat");
      expect(response.headers.get("location")).toBe("/dashboard");

      const accounts = yield* database.query("test.accounts", (db) =>
        db.select().from(schema.account),
      );

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.githubLogin).toBe("octocat");
    }),
  );
});

test("concurrent callbacks keep each GitHub profile bound to its own account", async () => {
  await run(
    Effect.gen(function* () {
      const responses = yield* Effect.all([finish("octocat"), finish("ada")], { concurrency: 2 });
      expect(responses.map((response) => response.headers.get("location"))).toEqual([
        "/dashboard",
        "/dashboard",
      ]);
      const database = yield* Database;

      const accounts = yield* database.query("test.accounts", (db) =>
        db.select().from(schema.account),
      );

      const users = yield* database.query("test.owners", (db) => db.select().from(schema.user));
      expect(users.filter((user) => user.role === "owner")).toHaveLength(1);
      expect(users.filter((user) => user.role === "member")).toHaveLength(1);

      const profiles = yield* Effect.all([providerUser("octocat"), providerUser("ada")]);
      expect(accounts.map((account) => [account.accountId, account.githubLogin]).sort()).toEqual(
        profiles.map((profile) => [String(profile.id), profile.login]).sort(),
      );
    }),
  );
});

test("a tampered OAuth state creates no account or session", async () => {
  await run(
    Effect.gen(function* () {
      const callback = yield* authorize("octocat");
      const url = new URL(callback.url);
      url.searchParams.set("state", "tampered");
      const auth = yield* Auth;

      const response = yield* auth.handler(
        new Request(url.href, { headers: { cookie: callback.cookie } }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toBe("/dashboard");
      const database = yield* Database;
      expect(
        yield* database.query("test.accounts", (db) => db.select().from(schema.account)),
      ).toEqual([]);
      expect(
        yield* database.query("test.sessions", (db) => db.select().from(schema.session)),
      ).toEqual([]);
      expect(calls).toEqual([]);
    }),
  );
});

test("untrusted browser origins with cookies and callback redirects are rejected before contacting GitHub", async () => {
  await run(
    Effect.gen(function* () {
      const auth = yield* Auth;

      for (const [origin, callbackURL] of [
        ["https://evil.test", "/dashboard"],
        [ORIGIN, "https://evil.test"],
      ] as const) {
        const response = yield* auth.handler(
          new Request(`${ORIGIN}/api/auth/sign-in/social`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin,
              cookie: "existing-session=present",
            },
            body: JSON.stringify({ provider: "github", callbackURL }),
          }),
        );

        expect(response.status).toBe(403);
      }

      expect(calls).toEqual([]);
    }),
  );
});

test("instance signup domain policy gates new users and returning OAuth identities", async () => {
  await run(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* finish("octocat");
      const policy = { ...defaultInstancePolicy, allowedEmailDomains: ["other.example"] };
      yield* database.query("test.policy", (db) =>
        db.insert(schema.instanceSettings).values({
          id: 1,
          schemaVersion: 1,
          settings: {
            ...policy,
            allowedEmailDomains: [...policy.allowedEmailDomains],
            allowedGithubOrgs: [...policy.allowedGithubOrgs],
            allowedOidcIssuers: [...policy.allowedOidcIssuers],
          },
          updatedAt: Date.now(),
        }),
      );
      expect((yield* finish("octocat")).headers.get("location")).not.toBe("/dashboard");
      expect((yield* finish("ada")).headers.get("location")).not.toBe("/dashboard");
      const users = yield* database.query("test.users", (db) => db.select().from(schema.user));
      expect(users).toHaveLength(1);
    }),
  );
});
