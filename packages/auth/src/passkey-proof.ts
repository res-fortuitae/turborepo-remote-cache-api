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
