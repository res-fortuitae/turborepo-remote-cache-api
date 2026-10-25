import { schema, type DatabaseDrizzle } from "@repo/db";
import type { AuthSettings } from "@repo/deploy-config";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import * as Redacted from "effect/Redacted";
import { githubIdentityHooks } from "./github.ts";

export type BetterAuthSecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

export interface BetterAuthInput {
  readonly config: AuthSettings;
  readonly db: DatabaseDrizzle;
  readonly secondaryStorage: BetterAuthSecondaryStorage | undefined;
  readonly sendMagicLink?: (email: string, url: string) => Promise<void>;
}

/**
 * Storage follows ADR 0002. Schema-affecting options must match
 * `packages/db/scripts/auth-schema.config.ts`, which generates the tables.
 */
export const makeBetterAuth = ({
  config,
  db,
  secondaryStorage,
  sendMagicLink,
}: BetterAuthInput) => {
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (config.github !== undefined) {
    socialProviders.github = {
      clientId: config.github.clientId,
      clientSecret: Redacted.value(config.github.clientSecret),
    };
  }

  if (config.magicLink === true && sendMagicLink === undefined) {
    throw new Error("Magic-link authentication requires a mail delivery callback");
  }

  return betterAuth({
    appName: "Turborepo Remote Cache",
    basePath: "/api/auth",
    baseURL: config.baseURL,
    secret: Redacted.value(config.secret),
    trustedOrigins: [...config.trustedOrigins],
    socialProviders,
    emailAndPassword: { enabled: false },
    advanced: {
      // Better Auth otherwise disables these checks in NODE_ENV=test.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: config.baseURL?.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    account: {
      additionalFields: {
        // Stable GitHub id is already accountId; login is mutable profile metadata.
        githubLogin: { type: "string", required: false, input: false },
      },
    },
    ...githubIdentityHooks(),
    plugins:
      config.magicLink === true
        ? [
            magicLink({
              expiresIn: 600,
              allowedAttempts: 1,
              storeToken: "hashed",
              sendMagicLink: async ({ email, url }) => {
                if (sendMagicLink === undefined)
                  throw new Error("Magic-link mail delivery is unavailable");
                await sendMagicLink(email, url);
              },
            }),
          ]
        : [],
    // D1 has no interactive transactions; the SQLite adapter paths never need one.
    database: drizzleAdapter(db, { provider: "sqlite", schema: { ...schema }, transaction: false }),
    secondaryStorage,
    session: {
      // KV can lag revocation by about 60 s, so D1 keeps every session.
      storeSessionInDatabase: true,
      // A signed cookie cache would add another revocation lag.
      cookieCache: { enabled: false },
    },
    // Single-use tokens and device codes need D1's atomic consume.
    verification: { storeInDatabase: true },
    // KV counters aren't atomic. STV-446 may swap in the Rate Limiting binding.
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
  });
};

export type BetterAuthInstance = ReturnType<typeof makeBetterAuth>;
