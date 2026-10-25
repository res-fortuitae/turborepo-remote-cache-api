/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary exercising real WebAuthn cryptography. */
import { expect, test } from "bun:test";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { Database, schema } from "@repo/db";
import { defaultInstancePolicy } from "@repo/deploy-config";
import { Effect, Schema } from "effect";
import { Auth } from "./auth.ts";
import { AuthTest } from "./testing.ts";

const options = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }));

const sha = (bytes: string | Uint8Array) =>
  Uint8Array.from(createHash("sha256").update(bytes).digest());

const concat = (bytes: readonly Uint8Array[]) => {
  const joined = new Uint8Array(bytes.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;

  for (const value of bytes) {
    joined.set(value, offset);
    offset += value.length;
  }

  return joined;
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const baseHeaders = (token: string) =>
  new Headers({
    origin: "http://localhost",
    "content-type": "application/json",
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", "auth-test-secret-0123456789abcdef0123456789").update(token).digest("base64")}`)}`,
  });

const mergeCookies = (headers: Headers, response: Response) => {
  const cookies = new Map(
    (headers.get("cookie") ?? "").split("; ").map((cookie) => {
      const at = cookie.indexOf("=");

      return [cookie.slice(0, at), cookie.slice(at + 1)];
    }),
  );

  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }

  headers.set("cookie", Array.from(cookies, ([key, value]) => `${key}=${value}`).join("; "));
};

const request = (
  auth: typeof Auth.Service,
  headers: Headers,
  path: string,
  body?: Schema.JsonObject,
) =>
  auth.handler(
    new Request(`http://localhost/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

const seed = (role: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const now = new Date();
    yield* db.batch((db) => [
      db.insert(schema.user).values({
        id: "user",
        name: "User",
        email: "user@example.com",
        emailVerified: true,
        role,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(schema.session).values({
        id: "original-session",
        userId: "user",
        token: "original",
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    return baseHeaders("original");
  });

/** A software authenticator: real P-256 keys, COSE public key, CBOR attestation, DER assertion. */
const authenticator = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = Uint8Array.from(randomBytes(32));

  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url"))],
      [-3, Uint8Array.from(Buffer.from(jwk.y ?? "", "base64url"))],
    ]),
  );

  const client = (challenge: string, type: string) =>
    new TextEncoder().encode(
      JSON.stringify({ challenge, type, origin: "http://localhost", crossOrigin: false }),
    );

  return {
    registration: (challenge: string) => {
      const authData = concat([
        sha("localhost"),
        Uint8Array.from([0x45]),
        new Uint8Array(4),
        new Uint8Array(16),
        Uint8Array.from([0, id.length]),
        id,
        cose,
      ]);

      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, never>>([
          ["fmt", "none"],
          ["attStmt", new Map<string, never>()],
          ["authData", authData],
        ]),
      );

      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(client(challenge, "webauthn.create")),
          attestationObject: b64(attestation),
          transports: ["internal"],
        },
      };
    },
    authentication: (challenge: string, userVerified = true) => {
      const clientData = client(challenge, "webauthn.get");

      const authData = concat([
        sha("localhost"),
        Uint8Array.from([userVerified ? 0x05 : 0x01]),
        Uint8Array.from([0, 0, 0, 1]),
      ]);

      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData),
          authenticatorData: b64(authData),
          signature: b64(
            Uint8Array.from(sign("sha256", concat([authData, sha(clientData)]), privateKey)),
          ),
          userHandle: null,
        },
      };
    },
  };
};

test("real passkey registration and verification rotate the session and produce fresh D1 step-up proof", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const db = yield* Database;
      const headers = yield* seed("owner");
      const device = authenticator();
      const registration = yield* request(auth, headers, "/passkey/generate-register-options");
      expect(registration.status).toBe(200);
      mergeCookies(headers, registration);

      const registrationOptions = yield* Effect.promise(async () =>
        options(await registration.json()),
      );

      const registered = yield* request(auth, headers, "/passkey/verify-registration", {
        response: device.registration(registrationOptions.challenge),
        name: "Test key",
      });

      expect(registered.status).toBe(200);
      expect(
        (yield* request(auth, headers, "/instance/settings", {
          policy: { ...defaultInstancePolicy, requirePasskeyForAdmins: true },
        })).status,
      ).toBe(403);

      const authentication = yield* request(
        auth,
        headers,
        "/passkey/generate-authenticate-options",
      );

      expect(authentication.status).toBe(200);
      mergeCookies(headers, authentication);
      const authOptions = yield* Effect.promise(async () => options(await authentication.json()));

      const verified = yield* request(auth, headers, "/passkey/verify-authentication", {
        response: device.authentication(authOptions.challenge),
      });

      expect(verified.status).toBe(200);
      mergeCookies(headers, verified);
      const proofs = yield* db.query("test.proofs", (db) => db.select().from(schema.passkeyProof));
      expect(proofs).toHaveLength(1);
      expect(proofs[0]?.sessionId).not.toBe("original-session");
      expect(
        (yield* request(auth, headers, "/instance/settings", {
          policy: { ...defaultInstancePolicy, requirePasskeyForAdmins: true },
        })).status,
      ).toBe(200);
      expect(
        (yield* request(auth, baseHeaders("original"), "/instance/orgs/elevate", {
          orgId: "org",
          reason: "stale",
        })).status,
      ).toBe(401);
      yield* db.query("test.expire", (db) => db.update(schema.passkeyProof).set({ verifiedAt: 0 }));
      expect(
        (yield* request(auth, headers, "/instance/settings", { policy: defaultInstancePolicy }))
          .status,
      ).toBe(403);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("members cannot enroll and unauthenticated callers cannot use passkey login as a first factor", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const headers = yield* seed("member");
      expect((yield* request(auth, headers, "/passkey/generate-register-options")).status).toBe(
        403,
      );
      expect(
        (yield* request(auth, new Headers(), "/passkey/generate-authenticate-options")).status,
      ).toBe(401);
    }).pipe(Effect.provide(AuthTest)),
  );
});

test("valid signatures without user verification cannot create step-up proof; challenges are single use", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const db = yield* Database;
      const headers = yield* seed("owner");
      const device = authenticator();
      const registration = yield* request(auth, headers, "/passkey/generate-register-options");
      mergeCookies(headers, registration);

      const registrationOptions = yield* Effect.promise(async () =>
        options(await registration.json()),
      );

      expect(
        (yield* request(auth, headers, "/passkey/verify-registration", {
          response: device.registration(registrationOptions.challenge),
        })).status,
      ).toBe(200);

      const authentication = yield* request(
        auth,
        headers,
        "/passkey/generate-authenticate-options",
      );

      mergeCookies(headers, authentication);
      const challenge = yield* Effect.promise(async () => options(await authentication.json()));
      const response = device.authentication(challenge.challenge, false);
      expect(
        (yield* request(auth, headers, "/passkey/verify-authentication", { response })).status,
      ).not.toBe(200);
      expect(
        (yield* request(auth, headers, "/passkey/verify-authentication", {
          response: device.authentication(challenge.challenge),
        })).status,
      ).not.toBe(200);
      expect(
        yield* db.query("test.no-proof", (db) => db.select().from(schema.passkeyProof)),
      ).toEqual([]);
    }).pipe(Effect.provide(AuthTest)),
  );
});
