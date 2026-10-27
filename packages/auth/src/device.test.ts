/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun invokes the public service at this boundary. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { z } from "zod";
import { Effect, Layer } from "effect";
import { Auth } from "./auth.ts";
import { AuthTest } from "./testing.ts";
import { SecondaryStorageTest } from "./secondary-storage.ts";
import { eq } from "drizzle-orm";

const cookie = async (token: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return `better-auth.session_token=${encodeURIComponent(token + "." + btoa(String.fromCharCode(...new Uint8Array(sig))))}`;
};
for (const decision of ["approve", "deny"] as const)
  test(`device ${decision} is durable, audited, and single use with KV enabled`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        const auth = yield* Auth;
        const now = new Date();
        yield* db.batch((db) => [
          db.insert(schema.user).values({
            id: "ada",
            name: "Ada",
            email: "ada@example.com",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(schema.session).values({
            id: "browser",
            token: "browser-token",
            userId: "ada",
            expiresAt: new Date(Date.now() + 604800000),
            createdAt: now,
            updatedAt: now,
          }),
        ]);
        const signed = yield* Effect.promise(() => cookie("browser-token"));
        const request = (path: string, body?: object, browser = false) =>
          auth.handler(
            new Request(`http://localhost/api/auth${path}`, {
              method: body ? "POST" : "GET",
              headers: {
                origin: "http://localhost",
                "content-type": "application/json",
                "cf-connecting-ip": "192.0.2.1",
                ...(browser ? { cookie: signed } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            }),
          );
        const started = yield* request("/device/code", { client_id: "tcache", scope: "developer" });
        expect(started.status).toBe(200);
        const code = z
          .object({
            user_code: z.string(),
            device_code: z.string(),
            expires_in: z.number(),
            interval: z.number(),
          })
          .parse(yield* Effect.promise(() => started.json()));
        expect(code.expires_in).toBe(300);
        expect(code.interval).toBe(5);
        const rows = yield* db.query("test.codes", (db) => db.select().from(schema.deviceCode));
        expect(rows[0]?.requestIp).toBe("192.0.2.1");
        const poll = {
          client_id: "tcache",
          device_code: code.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        };
        const pending = yield* request("/device/token", poll);
        expect(
          z.object({ error: z.string() }).parse(yield* Effect.promise(() => pending.json())).error,
        ).toBe("authorization_pending");
        const slow = yield* request("/device/token", poll);
        expect(
          z.object({ error: z.string() }).parse(yield* Effect.promise(() => slow.json())).error,
        ).toBe("slow_down");
        expect((yield* request(`/device?user_code=${code.user_code}`)).status).toBe(401);
        const review = yield* request(`/device?user_code=${code.user_code}`, undefined, true);
        expect(
          z.object({ request_ip: z.string() }).parse(yield* Effect.promise(() => review.json()))
            .request_ip,
        ).toBe("192.0.2.1");
        expect((yield* request(`/device/${decision}`, { userCode: code.user_code })).status).toBe(
          401,
        );
        expect(
          (yield* request(`/device/${decision}`, { userCode: code.user_code }, true)).status,
        ).toBe(200);
        expect(
          (yield* request(`/device/${decision}`, { userCode: code.user_code }, true)).status,
        ).toBe(400);
        const events = yield* db.query("test.audit", (db) => db.select().from(schema.auditEvent));
        expect(
          events.some(
            (e) => e.payload.action === `device.${decision === "approve" ? "approved" : "denied"}`,
          ),
        ).toBe(true);
        // Advance persisted polling state without a wall-clock wait.
        yield* db.query("test.pollTime", (db) =>
          db
            .update(schema.deviceCode)
            .set({ lastPolledAt: new Date(0) })
            .where(eq(schema.deviceCode.deviceCode, code.device_code)),
        );
        const redeemed = yield* request("/device/token", poll);
        const value = z
          .object({ access_token: z.string().optional(), error: z.string().optional() })
          .parse(yield* Effect.promise(() => redeemed.json()));
        if (decision === "approve") {
          expect(redeemed.status).toBe(200);
          expect(typeof value.access_token).toBe("string");
          expect((yield* request("/device/token", poll)).status).toBe(400);
        } else expect(value.error).toBe("access_denied");
      }).pipe(Effect.provide(AuthTest.pipe(Layer.provideMerge(SecondaryStorageTest)))),
    );
  });
