import { schema, type DatabaseDrizzle } from "@repo/db";
import { APIError } from "better-auth/api";
import { and, eq, gt, lte } from "drizzle-orm";

export const PASSKEY_FRESH_MILLIS = 5 * 60 * 1000;

/** Proof is authoritative, session-bound, and never read from KV or client input. */
export const requirePasskeyProof = async (
  db: DatabaseDrizzle,
  sessionId: string,
  userId: string,
) => {
  const now = Date.now();

  const [proof] = await db
    .select()
    .from(schema.passkeyProof)
    .where(
      and(
        eq(schema.passkeyProof.sessionId, sessionId),
        eq(schema.passkeyProof.userId, userId),
        gt(schema.passkeyProof.verifiedAt, now - PASSKEY_FRESH_MILLIS),
        lte(schema.passkeyProof.verifiedAt, now),
      ),
    );

  if (!proof)
    throw new APIError("FORBIDDEN", {
      code: "PASSKEY_STEP_UP_REQUIRED",
      message: "A fresh passkey check is required",
    });
};

/** Management step-up covers instance administrators, never organization/project roles.
 * Read the live role so callers cannot bypass proof with a stale or omitted role.
 */
export const requireManagementPasskeyProof = async (
  db: DatabaseDrizzle,
  policy: { readonly requirePasskeyForAdmins: boolean },
  sessionId: string,
  userId: string,
) => {
  if (!policy.requirePasskeyForAdmins) return;
  const [user] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!user) throw new APIError("FORBIDDEN", { message: "A live user is required" });
  if (user.role === "owner" || user.role === "admin") {
    await requirePasskeyProof(db, sessionId, userId);
  }
};
