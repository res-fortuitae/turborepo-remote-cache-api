import type { SessionReader } from "./session-reader.ts";
import { bootstrapOwner } from "./bootstrap.ts";
import * as Effect from "effect/Effect";
import { auditedAdapter } from "./audit-adapter.ts";
import { apiKey } from "@better-auth/api-key";
import { schema, type DatabaseDrizzle } from "@repo/db";
import type { AuthSettings } from "@repo/deploy-config";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";
import * as Redacted from "effect/Redacted";
import type { AuditLogService } from "@repo/audit";
import { APIError } from "better-auth/api";
import { readInstancePolicy, instancePlugin } from "./instance.ts";
import { organizationPlugins } from "./organizations.ts";
import { passkeyPlugins } from "./passkeys.ts";
import { instanceAdmin } from "./instance-access.ts";
import { devicePlugins } from "./device.ts";
import { githubIdentityHooks } from "./github.ts";

export type BetterAuthSecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

export interface BetterAuthInput {
  readonly config: AuthSettings;
  readonly rateLimitStorage: NonNullable<
    NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]
  >;
  readonly db: DatabaseDrizzle;
  readonly secondaryStorage: BetterAuthSecondaryStorage | undefined;
  readonly sendInvitation?: (email: string, org: string, url: string) => Promise<boolean>;
  readonly audit?: AuditLogService;
  readonly sendMagicLink?: (email: string, url: string) => Promise<void>;
}

/**
 * Storage follows ADR 0002. Schema-affecting options must match
 * `packages/db/scripts/auth-schema.config.ts`, which generates the tables.
 */
export const makeBetterAuth = ({
  config,
  rateLimitStorage,
  db,
  secondaryStorage,
  sendMagicLink,
  audit,
  sendInvitation,
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

  const identity = githubIdentityHooks();

  let readSession: SessionReader = async () => null;
  const sessionReader: SessionReader = (headers) => readSession(headers);

  const auth = betterAuth({
    appName: "Turborepo Remote Cache",
    basePath: "/api/auth",
    baseURL: config.baseURL,
    secret: Redacted.value(config.secret),
    trustedOrigins: [...config.trustedOrigins],
    socialProviders,
    emailAndPassword: { enabled: false },
    advanced: {
      // Better Auth otherwise disables these checks in NODE_ENV=test.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: config.baseURL?.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    account: {
      encryptOAuthTokens: true,
      additionalFields: {
        // Stable GitHub id is already accountId; login is mutable profile metadata.
        githubLogin: { type: "string", required: false, input: false },
      },
    },
    ...identity,
    user: {
      ...identity.user,
      validateUserInfo: async (data, context) => {
        await identity.user.validateUserInfo(data, context);
        const policy = await readInstancePolicy(db, config);

        if (policy.allowedEmailDomains.length > 0) {
          const email = data.user.email;
          const domain = typeof email === "string" ? email.split("@")[1]?.toLowerCase() : undefined;

          if (
            !data.user.emailVerified ||
            !domain ||
            !policy.allowedEmailDomains.some((allowed) => allowed.toLowerCase() === domain)
          )
            throw new APIError("FORBIDDEN", {
              message: "Email domain is not allowed by instance policy",
            });
        }

        if (policy.allowedGithubOrgs.length > 0) {
          const login = data.source.oauth?.profile?.login;

          if (data.source.oauth?.providerId !== "github" || typeof login !== "string")
            throw new APIError("FORBIDDEN");
          let allowed = false;

          for (const org of policy.allowedGithubOrgs) {
            const response = await fetch(
              `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
              {
                headers: {
                  Accept: "application/vnd.github+json",
                  "User-Agent": "turborepo-remote-cache",
                },
                signal: AbortSignal.timeout(5000),
              },
            );

            if (response.status === 204) allowed = true;
          }

          if (!allowed)
            throw new APIError("FORBIDDEN", {
              message: "GitHub organization membership is required",
            });
        }
      },
    },
    databaseHooks: {
      ...identity.databaseHooks,
      user: {
        create: {
          after: async (user) => {
            if (!audit) throw new APIError("SERVICE_UNAVAILABLE", { message: "Audit unavailable" });
            await Effect.runPromise(bootstrapOwner(audit, user.id));
          },
        },
      },
    },
    plugins: [
      apiKey({
        references: "organization",
        defaultPrefix: "tcache_",
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: 30 * 86400, minExpiresIn: 1 / 86400, maxExpiresIn: 90 },
        enableSessionForAPIKeys: false,
      }),
      bearer(),
      ...devicePlugins(sessionReader, db, audit),
      instanceAdmin(),
      ...passkeyPlugins(sessionReader, db, config, audit),
      ...organizationPlugins(sessionReader, db, config, audit, sendInvitation),
      instancePlugin(sessionReader, db, config, audit),
      ...(config.magicLink === true
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
        : []),
    ],
    // D1 has no interactive transactions; the SQLite adapter paths never need one.
    database: (options) =>
      auditedAdapter(
        drizzleAdapter(db, { provider: "sqlite", schema: { ...schema }, transaction: false })(
          options,
        ),
        db,
        audit,
      ),
    secondaryStorage,
    session: {
      // KV can lag revocation by about 60 s, so D1 keeps every session.
      storeSessionInDatabase: true,
      // A signed cookie cache would add another revocation lag.
      cookieCache: { enabled: false },
    },
    // Single-use tokens and device codes need D1's atomic consume.
    verification: { storeInDatabase: true },
    // Atomic binding checks; session secondary storage never stores counters.
    rateLimit: { enabled: true, customStorage: rateLimitStorage },
    disabledPaths: [
      "/api-key/create",
      "/api-key/update",
      "/api-key/delete",
      "/api-key/list",
      "/api-key/get",
    ],
    telemetry: { enabled: false },
  });

  readSession = (headers) =>
    auth.api.getSession({ headers: headers ?? new Headers(), query: { disableCookieCache: true } });
  return auth;
};

export type BetterAuthInstance = ReturnType<typeof makeBetterAuth>;
