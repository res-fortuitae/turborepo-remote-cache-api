import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import * as Schema from "effect/Schema";

const GitHubProfile = Schema.Struct({
  id: Schema.Union([
    Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
    Schema.Int.check(Schema.isGreaterThan(0)),
  ]),
  login: Schema.NonEmptyString,
});

const decodeProfile = Schema.decodeUnknownSync(GitHubProfile);

/**
 * Better Auth exposes the verified profile to validateUserInfo, but not to
 * account database hooks. Carry it between those hooks by endpoint context.
 * Weak keys keep requests isolated even when an auth instance serves concurrent
 * callbacks; no profile or token is stored in module-level state.
 */
export const githubIdentityHooks = () => {
  const profiles = new WeakMap<object, { accountId: string; login: string }>();

  return {
    user: {
      validateUserInfo: ({ source }, context) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "github") return;
        const profile = decodeProfile(source.oauth.profile);
        profiles.set(context.context, { accountId: String(profile.id), login: profile.login });
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account, context) => {
            if (account.providerId !== "github") return;
            const profile = context === null ? undefined : profiles.get(context.context);

            if (profile === undefined || profile.accountId !== account.accountId) {
              throw new APIError("FORBIDDEN", {
                message: "GitHub account identity is unavailable",
              });
            }

            return { data: { ...account, githubLogin: profile.login } };
          },
        },
        update: {
          before: async (account, context) => {
            if (account.providerId !== "github") return;
            const profile = context === null ? undefined : profiles.get(context.context);

            if (profile === undefined) {
              throw new APIError("FORBIDDEN", {
                message: "GitHub account identity is unavailable",
              });
            }

            return { data: { ...account, githubLogin: profile.login } };
          },
        },
      },
    },
  } satisfies Pick<BetterAuthOptions, "user" | "databaseHooks">;
};
