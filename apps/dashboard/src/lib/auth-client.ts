import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  deviceAuthorizationClient,
  organizationClient,
} from "better-auth/client/plugins";

/** Better Auth on the same origin: the session is an HttpOnly cookie. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    organizationClient({ teams: { enabled: true }, dynamicAccessControl: { enabled: true } }),
    adminClient(),
    passkeyClient(),
    deviceAuthorizationClient(),
  ],
});

export type Session = NonNullable<ReturnType<typeof authClient.useSession>["data"]>;

export const signInWithGitHub = async (callbackURL = window.location.href) => {
  const result = await authClient.signIn.social({ provider: "github", callbackURL });

  if (result.error) throw new Error(result.error.message ?? "GitHub sign-in is unavailable.");
};
