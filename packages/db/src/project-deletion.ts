import { eq, sql } from "drizzle-orm";
import type { DatabaseQueries } from "./database.ts";
import * as schema from "./schema/index.ts";

/** Durable intents survive removal of the organization and have no foreign key. */
export const deleteOrganizationProjects = (db: DatabaseQueries, orgId: string, now: number) =>
  [
    db
      .insert(schema.projectDeletion)
      .select(
        db
          .select({
            projectId: schema.project.id,
            orgId: schema.project.orgId,
            requestedAt: sql<number>`${now}`.as("requested_at"),
            completedAt: sql<null>`null`.as("completed_at"),
          })
          .from(schema.project)
          .where(eq(schema.project.orgId, orgId)),
      )
      .onConflictDoNothing(),
    db.update(schema.project).set({ archivedAt: now }).where(eq(schema.project.orgId, orgId)),
    db
      .update(schema.trustPolicy)
      .set({ enabled: false })
      .where(
        sql`${schema.trustPolicy.projectId} in (select id from project where org_id = ${orgId})`,
      ),
  ] as const;
