import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/** Generation only; runtime auth composition belongs to @repo/auth (STV-432). */
export const auth = betterAuth({
  advanced: { database: { validateSchema: false } },
  database: drizzleAdapter({}, { provider: "sqlite" }),
  baseURL: "https://schema.invalid",
  secret: "schema-generation-only-not-a-runtime-secret",
});
