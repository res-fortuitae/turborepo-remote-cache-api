/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary runs the real auth layer locally. */
import { expect, test } from "bun:test";
import { Auth, AuthLive, AuthKvNamespace, SecondaryStorage } from "@repo/auth";
import { AuditLogTest } from "@repo/audit/testing";
import { DatabaseTest } from "@repo/db/testing";
import { AuthConfig } from "@repo/deploy-config";
import { Mailer } from "@repo/mailer";
import { RateLimiterTest } from "@repo/ratelimit";
import { Effect, Layer, Option, Redacted } from "effect";
import { authStorageLayer, residencyFromEnvironment } from "../src/residency-storage.ts";

const ORIGIN = "http://localhost";

test.each(["default", "eu", "fedramp"])(
  "%s signs in and validates sessions with the permitted storage",
  async (value) => {
    const writes: string[] = [];
    const entries = new Map<string, string>();
    const messages: string[] = [];
    const storage = authStorageLayer(residencyFromEnvironment(value)).pipe(
      Layer.provide(
        Layer.succeed(AuthKvNamespace, {
          get: async (key) => entries.get(key) ?? null,
          put: async (key, data) => {
            writes.push(key);
            entries.set(key, data);
          },
          delete: async (key) => {
            entries.delete(key);
          },
        }),
      ),
    );
    const layer = AuthLive.pipe(
      Layer.provideMerge(storage),
      Layer.provide(
        Layer.mergeAll(
          RateLimiterTest,
          AuditLogTest,
          Layer.succeed(AuthConfig, {
            secret: Redacted.make("residency-test-secret-0123456789abcdef0123456789"),
            baseURL: ORIGIN,
            trustedOrigins: [ORIGIN],
            magicLink: true,
          }),
          Layer.succeed(Mailer, {
            send: (message) =>
              Effect.sync(() => {
                messages.push(message.text);
              }),
          }),
        ),
      ),
      Layer.provide(DatabaseTest),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(Option.isSome(yield* Effect.serviceOption(SecondaryStorage))).toBe(
          value === "default",
        );
        const auth = yield* Auth;
        const started = yield* auth.handler(
          new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN },
            body: JSON.stringify({ email: "ada@example.com", callbackURL: "/dashboard" }),
          }),
        );
        expect(started.status).toBe(200);
        const link = messages[0]!.split("\n\n")[1]!;
        const response = yield* auth.handler(new Request(link));
        expect(response.status).toBe(302);
        const cookie = response.headers
          .getSetCookie()
          .map((part) => part.split(";")[0])
          .join("; ");
        const session = yield* auth.requireSession(new Headers({ cookie }));
        expect(session.user.email).toBe("ada@example.com");
        expect((yield* auth.requireFreshSession(new Headers({ cookie }))).user.email).toBe(
          "ada@example.com",
        );
      }).pipe(Effect.provide(layer)),
    );
    if (value === "default") expect(writes.length).toBeGreaterThan(0);
    else expect(writes).toEqual([]);
  },
);

test.each([undefined, "", "EU", "us", null])(
  "invalid deployment policy %p fails closed",
  (value) => {
    expect(() => residencyFromEnvironment(value)).toThrow("STORAGE_JURISDICTION");
  },
);
