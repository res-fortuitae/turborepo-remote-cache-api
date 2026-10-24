/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun calls the public auth service at this test boundary. */
import { expect, test } from "bun:test";
import { AuditLogTest } from "@repo/audit/testing";
import { Database, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { AuthConfig } from "@repo/deploy-config";
import { Mailer, type MailMessage } from "@repo/mailer";
import { Effect, Layer, Redacted } from "effect";
import { Auth, AuthLive } from "./auth.ts";

const ORIGIN = "https://cache.test";

const run = <A, E>(
  effect: Effect.Effect<A, E, Auth | Database>,
  messages: MailMessage[],
  enabled: boolean,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        AuthLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AuthConfig, {
                secret: Redacted.make("magic-link-test-secret-0123456789abcdef0123456789"),
                baseURL: ORIGIN,
                trustedOrigins: [ORIGIN],
                magicLink: enabled,
              }),
              Layer.succeed(Mailer, {
                send: (message) =>
                  Effect.sync(() => {
                    messages.push(message);
                  }),
              }),
              AuditLogTest,
            ),
          ),
          Layer.provideMerge(DatabaseTest),
        ),
      ),
    ),
  );

const requestLink = () =>
  new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "ada@example.com", callbackURL: "/dashboard" }),
  });

test("opt-in email sign-in delivers a hashed, single-use magic link and creates a session", async () => {
  const messages: MailMessage[] = [];
  await run(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const started = yield* auth.handler(requestLink());
      expect(started.status).toBe(200);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.to).toBe("ada@example.com");
      const link = messages[0]!.text.split("\n\n")[1]!;
      const url = new URL(link);
      expect(url.origin).toBe(ORIGIN);
      const database = yield* Database;

      const pending = yield* database.query("test.magicLink", (db) =>
        db.select().from(schema.verification),
      );

      expect(pending).toHaveLength(1);
      expect(JSON.stringify(pending)).not.toContain(url.searchParams.get("token")!);

      const response = yield* auth.handler(new Request(link));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);

      const cookies = response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");

      const session = yield* auth.requireFreshSession(new Headers({ cookie: cookies }));
      expect(session.user.email).toBe("ada@example.com");
      expect(session.user.emailVerified).toBe(true);

      const replay = yield* auth.handler(new Request(link));
      expect(replay.headers.get("location")).not.toBe(`${ORIGIN}/dashboard`);

      const sessions = yield* database.query("test.sessions", (db) =>
        db.select().from(schema.session),
      );

      expect(sessions).toHaveLength(1);
    }),
    messages,
    true,
  );
});

test("magic links are unavailable unless explicitly enabled", async () => {
  const messages: MailMessage[] = [];
  await run(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const response = yield* auth.handler(requestLink());
      expect(response.status).toBe(404);
      expect(messages).toEqual([]);
    }),
    messages,
    false,
  );
});

test("password registration and an unconfigured GitHub provider stay disabled", async () => {
  await run(
    Effect.gen(function* () {
      const auth = yield* Auth;

      for (const [path, body, status] of [
        [
          "/sign-up/email",
          { email: "ada@example.com", password: "test-password-long-enough", name: "Ada" },
          400,
        ],
        ["/sign-in/social", { provider: "github", callbackURL: "/dashboard" }, 404],
      ] as const) {
        const response = yield* auth.handler(
          new Request(`${ORIGIN}/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN },
            body: JSON.stringify(body),
          }),
        );

        expect(response.status).toBe(status);
      }

      const database = yield* Database;
      expect(
        yield* database.query("test.accounts", (db) => db.select().from(schema.account)),
      ).toEqual([]);
    }),
    [],
    false,
  );
});
