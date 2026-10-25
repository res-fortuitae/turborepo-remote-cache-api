import { schema, type DatabaseDrizzle } from "@repo/db";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const organizationAccess = createAccessControl({
  ...defaultStatements,
  organization: [...defaultStatements.organization, "transfer"],
  project: ["create", "read", "update", "delete", "grant"],
  trustPolicy: ["create", "update", "delete"],
  apiKey: ["create", "revoke"],
  audit: ["read", "export"],
  analytics: ["read"],
  billing: ["update"],
  settings: ["update"],
});
export const organizationRoles = {
  owner: organizationAccess.newRole(organizationAccess.statements),
  admin: organizationAccess.newRole({ ...organizationAccess.statements, organization: ["update"] }),
  member: organizationAccess.newRole({}),
  auditor: organizationAccess.newRole({ audit: ["read"], analytics: ["read"] }),
};

const permissions = z.record(z.string(), z.array(z.string()));
/** Callback boundary for Better Auth endpoints; the caller supplies a fresh D1 user. */
export const hasOrganizationPermission = async (
  db: DatabaseDrizzle,
  orgId: string,
  userId: string,
  resource: keyof typeof organizationAccess.statements,
  action: string,
) => {
  if (!organizationAccess.statements[resource].some((known) => known === action)) return false;
  const [member] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));
  if (!member) return false;
  for (const name of member.role.split(",").map((role) => role.trim())) {
    const builtIn = Object.entries(organizationRoles).find(([role]) => role === name)?.[1];
    if (builtIn) {
      if (permissions.parse(builtIn.statements)[resource]?.includes(action)) return true;
      continue;
    }
    const [custom] = await db
      .select()
      .from(schema.organizationRole)
      .where(
        and(
          eq(schema.organizationRole.organizationId, orgId),
          eq(schema.organizationRole.role, name),
        ),
      );
    if (custom && permissions.parse(JSON.parse(custom.permission))[resource]?.includes(action))
      return true;
  }
  return false;
};

export const canDelegateOrganizationRole = async (
  db: DatabaseDrizzle,
  orgId: string,
  userId: string,
  name: string,
) => {
  if (name === "owner" || name.includes(",")) return false;
  const builtIn = Object.entries(organizationRoles).find(([role]) => role === name)?.[1];
  const [custom] = builtIn
    ? []
    : await db
        .select()
        .from(schema.organizationRole)
        .where(
          and(
            eq(schema.organizationRole.organizationId, orgId),
            eq(schema.organizationRole.role, name),
          ),
        );
  if (!builtIn && !custom) return false;
  const requested = builtIn
    ? permissions.parse(builtIn.statements)
    : permissions.parse(JSON.parse(custom?.permission ?? "{}"));
  for (const [resource, actions] of Object.entries(requested)) {
    const known = Object.keys(organizationAccess.statements).find((key) => key === resource);
    if (!known) return false;
    for (const action of actions) {
      // SAFETY: key was matched against the access controller's own statement keys.
      if (
        !(await hasOrganizationPermission(
          db,
          orgId,
          userId,
          known as keyof typeof organizationAccess.statements,
          action,
        ))
      )
        return false;
    }
  }
  return true;
};
