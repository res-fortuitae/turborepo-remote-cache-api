import { can, effectivePermissions, type CustomRole } from "./org-admin.ts";
import type { ProjectRole } from "./projects.ts";

export type AccessAction = "cache:read" | "cache:write" | "read" | "update" | "grant" | "delete";

export const accessActions: ReadonlyArray<{
  readonly action: AccessAction;
  readonly label: string;
}> = [
  { action: "cache:read", label: "read the cache" },
  { action: "cache:write", label: "write to the cache" },
  { action: "read", label: "view the project" },
  { action: "update", label: "change settings" },
  { action: "grant", label: "manage access" },
  { action: "delete", label: "delete the project" },
];

export interface AccessFacts {
  readonly userId: string;
  readonly orgRole: string | undefined;
  readonly customRoles: ReadonlyArray<CustomRole>;
  readonly grants: ReadonlyArray<{
    readonly principalType: "user" | "team";
    readonly principalId: string;
    readonly role: ProjectRole;
  }>;
  /** Group ID → member user IDs. */
  readonly groupMembers: ReadonlyMap<string, ReadonlySet<string>>;
  readonly groupNames: ReadonlyMap<string, string>;
  readonly archived: boolean;
}

export interface AccessExplanation {
  readonly allowed: boolean;
  /** Every path that grants the action, strongest first; or why nothing does. */
  readonly reasons: ReadonlyArray<string>;
}

const roleAllows = (role: ProjectRole, action: AccessAction) =>
  role === "project:admin"
    ? true
    : role === "cache:write"
      ? ["read", "cache:read", "cache:write"].includes(action)
      : ["read", "cache:read"].includes(action);

const roleNames: Record<ProjectRole, string> = {
  "project:admin": "Admin",
  "cache:write": "Read and write",
  "cache:read": "Read",
};

/**
 * Mirrors the server's decision for a signed-in member (`@repo/authz` decide):
 * org role statements first (never cache access), then direct and group grants.
 * Instance elevation is not shown; it is temporary and audited.
 */
export function explainAccess(facts: AccessFacts, action: AccessAction): AccessExplanation {
  if (facts.orgRole === undefined)
    return { allowed: false, reasons: ["Not a member of this organization."] };
  const reasons: string[] = [];

  if (facts.archived && action === "cache:write")
    return {
      allowed: false,
      reasons: ["The project is archived, so nobody can write to its cache."],
    };

  if (!action.startsWith("cache:")) {
    const permissions = effectivePermissions(facts.orgRole, facts.customRoles);

    if (can(permissions, "project", action))
      reasons.push(
        `Organization role "${facts.orgRole}" includes project:${action} for every project.`,
      );
  }

  for (const grant of facts.grants) {
    if (!roleAllows(grant.role, action)) continue;

    if (grant.principalType === "user" && grant.principalId === facts.userId)
      reasons.push(`Direct grant: ${roleNames[grant.role]}.`);

    if (
      grant.principalType === "team" &&
      facts.groupMembers.get(grant.principalId)?.has(facts.userId)
    )
      reasons.push(
        `Member of group "${facts.groupNames.get(grant.principalId) ?? grant.principalId}", which is granted ${roleNames[grant.role]}.`,
      );
  }

  if (reasons.length > 0) return { allowed: true, reasons };

  return {
    allowed: false,
    reasons: [
      action.startsWith("cache:")
        ? "No direct or group grant on this project allows it. Organization roles never grant cache access."
        : "Neither their organization role nor any project grant allows it.",
    ],
  };
}
