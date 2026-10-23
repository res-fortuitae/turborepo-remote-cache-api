import { schema, type DatabaseDrizzle } from "@repo/db";
import type { AuthSettings } from "@repo/deploy-config";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as Redacted from "effect/Redacted";

export type BetterAuthSecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

export interface BetterAuthInput {
  readonly config: AuthSettings;
  readonly db: DatabaseDrizzle;
  readonly secondaryStorage: BetterAuthSecondaryStorage | undefined;
}

/**
 * Storage follows ADR 0002. Schema-affecting options must match
 * `packages/db/scripts/auth-schema.config.ts`, which generates the tables.
 */
export const makeBetterAuth = ({ config, db, secondaryStorage }: BetterAuthInput) =>
  betterAuth({
    appName: "Turborepo Remote Cache",
    basePath: "/api/auth",
    baseURL: config.baseURL,
    secret: Redacted.value(config.secret),
    trustedOrigins: [...config.trustedOrigins],
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

export type BetterAuthInstance = ReturnType<typeof makeBetterAuth>;
