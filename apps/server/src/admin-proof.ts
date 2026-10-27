import { requirePasskeyProof } from "@repo/auth";
import { AuthorizationCeilings } from "@repo/authz";
import { Database, InstanceSettingsRepo } from "@repo/db";
import { Forbidden } from "@repo/api-spec";
import { Effect } from "effect";

/** Resolve organization tightening before accepting a sensitive administrator mutation. */
export const requireAdminProof = Effect.fn("Management.requireAdminProof")(function* (
  orgId: string,
  user: { readonly id: string; readonly role?: string | null },
  sessionId: string,
) {
  const policy = yield* (yield* InstanceSettingsRepo).policy(orgId, yield* AuthorizationCeilings);
  if (policy.requirePasskeyForAdmins && ["owner", "admin"].includes(user.role ?? "")) {
    const db = yield* Database;
    yield* Effect.tryPromise({
      try: () => requirePasskeyProof(db.drizzle, sessionId, user.id),
      catch: () => new Forbidden({ message: "Verify an administrator passkey first" }),
    });
  }
  return policy;
});
