import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { admin } from "better-auth/plugins/admin";
import { magicLink } from "better-auth/plugins/magic-link";

/**
 * Generation only; runtime auth composition belongs to @repo/auth (STV-432).
 * Keep schema-affecting options in sync with `packages/auth/src/options.ts`;
 * @repo/auth's schema test fails when a table or column is missing.
 */
export const auth = betterAuth({
  advanced: { database: { validateSchema: false } },
  database: drizzleAdapter({}, { provider: "sqlite" }),
  baseURL: "https://schema.invalid",
  secret: "schema-generation-only-not-a-runtime-secret",
  rateLimit: { storage: "database" },
  account: {
    additionalFields: {
      githubLogin: { type: "string", required: false, input: false },
    },
  },
  plugins: [
    passkey(),
    organization({ dynamicAccessControl: { enabled: true }, teams: { enabled: true } }),
    admin(),
    magicLink({ storeToken: "hashed", sendMagicLink: async () => {} }),
  ],
});
