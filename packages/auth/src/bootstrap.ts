import type { AuditLogService } from "@repo/audit";
import { schema } from "@repo/db";
import { and, eq, sql } from "drizzle-orm";

/** The event describes the conditional check, including when another user already owns the instance. */
export const bootstrapOwner = (audit: AuditLogService, userId: string) =>
  audit.commit(
    {
      scope: "instance",
      actor: { type: "system", id: "owner-bootstrap", display: "Owner bootstrap" },
      action: "instance.owner.bootstrap.checked",
      target: { type: "user", id: userId },
      outcome: "allow",
      ip: "",
      userAgent: "",
      requestId: crypto.randomUUID(),
      metadata: {},
    },
    (db) => [
      // The predicate and audit insert share one atomic batch; simultaneous signups cannot claim two owners.
      db
        .update(schema.user)
        .set({ role: "owner" })
        .where(
          and(
            eq(schema.user.id, userId),
            sql`not exists (select 1 from user where role = 'owner')`,
          ),
        ),
    ],
  );
