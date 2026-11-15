import type { InstancePolicy, AuthSettings } from "@repo/deploy-config";
import { schema, type DatabaseDrizzle } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { Redacted } from "effect";

export const checkEmailPolicy = (policy: InstancePolicy, email: string, verified: boolean) => {
  if (
    policy.allowedEmailDomains.length &&
    (!verified ||
      !policy.allowedEmailDomains.some(
        (domain) => domain.toLowerCase() === email.split("@")[1]?.toLowerCase(),
      ))
  )
    throw new APIError("FORBIDDEN", { message: "Email domain is not allowed by identity policy" });
};

export const checkGithubPolicy = async (orgs: readonly string[], token?: string) => {
  if (!orgs.length) return;
  if (!token)
    throw new APIError("FORBIDDEN", {
      message: "Sign in with GitHub to verify organization membership",
    });
  try {
    for (const org of orgs) {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "turborepo-remote-cache",
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.status === 404) continue;
      if (!response.ok) throw new Error("Membership service unavailable");
      const membership = (await response.json()) as { state?: string };
      if (membership.state === "active") return;
    }
  } catch {
    throw new APIError("FORBIDDEN", {
      message: "GitHub membership verification unavailable; sign in again with read:org access",
    });
  }
  throw new APIError("FORBIDDEN", { message: "Active GitHub organization membership is required" });
};

export const checkStoredIdentity = async (
  db: DatabaseDrizzle,
  config: AuthSettings,
  policy: InstancePolicy,
  user: { id: string; email: string; emailVerified: boolean },
) => {
  checkEmailPolicy(policy, user.email, user.emailVerified);
  if (!policy.allowedGithubOrgs.length) return;
  const [account] = await db
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "github")));
  let token: string | undefined;
  try {
    if (
      account?.accessToken &&
      (!account.accessTokenExpiresAt || account.accessTokenExpiresAt > new Date())
    )
      token = await symmetricDecrypt({
        key: Redacted.value(config.secret),
        data: account.accessToken,
      });
  } catch {
    throw new APIError("FORBIDDEN", { message: "Sign in with GitHub again" });
  }
  await checkGithubPolicy(policy.allowedGithubOrgs, token);
};
