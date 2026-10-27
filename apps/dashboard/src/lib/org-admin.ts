import { builtInOrganizationRoles, type OrganizationPermissions } from "@repo/shared";
import { api } from "./api.ts";

/** Better Auth organization endpoints, plus this instance's audited extensions. */
const auth = "/api/auth/organization";
const query = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

export interface Member {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly image?: string | null;
  };
}

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: "pending" | "accepted" | "rejected" | "canceled";
  readonly expiresAt: string;
  readonly inviterId: string;
}

export interface Group {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface GroupMember {
  readonly id: string;
  readonly teamId: string;
  readonly userId: string;
}

export interface CustomRole {
  readonly id: string;
  readonly role: string;
  readonly permission: OrganizationPermissions | string;
}

export const listMembers = (organizationId: string, signal?: AbortSignal) =>
  api<{ readonly members: ReadonlyArray<Member>; readonly total: number }>(
    `${auth}/list-members${query({ organizationId, limit: "200" })}`,
    { signal },
  );

export const updateMemberRole = (organizationId: string, memberId: string, role: string) =>
  api(`${auth}/update-member-role`, { method: "POST", body: { organizationId, memberId, role } });

export const removeMember = (organizationId: string, memberIdOrEmail: string) =>
  api(`${auth}/remove-member`, { method: "POST", body: { organizationId, memberIdOrEmail } });

export const invite = (input: {
  readonly organizationId: string;
  readonly email?: string;
  readonly githubUsername?: string;
  readonly role: string;
}) =>
  api<{ readonly invitation: Invitation; readonly url: string; readonly delivered: boolean }>(
    `${auth}/invite`,
    { method: "POST", body: input },
  );

export const listInvitations = (organizationId: string, signal?: AbortSignal) =>
  api<ReadonlyArray<Invitation>>(`${auth}/list-invitations${query({ organizationId })}`, {
    signal,
  });

export const cancelInvitation = (invitationId: string) =>
  api(`${auth}/cancel-invitation`, { method: "POST", body: { invitationId } });

export const invitationLink = (invitationId: string) =>
  api<{ readonly url: string }>(`${auth}/invitation-link`, {
    method: "POST",
    body: { invitationId },
  });

export const acceptSignedInvitation = (invitationId: string, signature: string) =>
  api<{ readonly organizationId?: string }>(`${auth}/accept-signed-invitation`, {
    method: "POST",
    body: { invitationId, signature },
  });

export const listGroups = (organizationId: string, signal?: AbortSignal) =>
  api<ReadonlyArray<Group>>(`${auth}/list-teams${query({ organizationId })}`, { signal });

export const createGroup = (organizationId: string, name: string) =>
  api<Group>(`${auth}/create-team`, { method: "POST", body: { organizationId, name } });

export const renameGroup = (organizationId: string, teamId: string, name: string) =>
  api<Group>(`${auth}/update-team`, {
    method: "POST",
    body: { teamId, data: { name, organizationId } },
  });

export const deleteGroup = (organizationId: string, teamId: string) =>
  api(`${auth}/remove-team`, { method: "POST", body: { organizationId, teamId } });

/** Any org member may read group composition (native list-team-members requires membership of the group). */
export const listGroupMembers = (organizationId: string, teamId: string, signal?: AbortSignal) =>
  api<ReadonlyArray<GroupMember>>(`${auth}/group-members${query({ organizationId, teamId })}`, {
    signal,
  });

export const addGroupMember = (organizationId: string, teamId: string, userId: string) =>
  api(`${auth}/add-team-member`, { method: "POST", body: { organizationId, teamId, userId } });

export const removeGroupMember = (organizationId: string, teamId: string, userId: string) =>
  api(`${auth}/remove-team-member`, {
    method: "POST",
    body: { organizationId, teamId, userId },
  });

export const listRoles = (organizationId: string, signal?: AbortSignal) =>
  api<ReadonlyArray<CustomRole>>(`${auth}/list-roles${query({ organizationId })}`, { signal });

export const createRole = (
  organizationId: string,
  role: string,
  permission: OrganizationPermissions,
) => api(`${auth}/create-role`, { method: "POST", body: { organizationId, role, permission } });

export const updateRole = (
  organizationId: string,
  roleName: string,
  permission: OrganizationPermissions,
) =>
  api(`${auth}/update-role`, {
    method: "POST",
    body: { organizationId, roleName, data: { permission } },
  });

export const deleteRole = (organizationId: string, roleName: string) =>
  api(`${auth}/delete-role`, { method: "POST", body: { organizationId, roleName } });

export const rolePermissions = (role: Pick<CustomRole, "permission">): OrganizationPermissions => {
  if (typeof role.permission !== "string") return role.permission;

  try {
    return JSON.parse(role.permission) as OrganizationPermissions;
  } catch {
    return {};
  }
};

export const builtInRoleNames = Object.keys(builtInOrganizationRoles);

/**
 * Union of the permissions of a member's comma-separated roles. Mirrors the
 * server's evaluation so the UI can hide actions; the server still decides.
 */
export const effectivePermissions = (
  roleList: string,
  customRoles: ReadonlyArray<CustomRole>,
): OrganizationPermissions => {
  const result: Record<string, Set<string>> = {};

  for (const name of roleList.split(",").map((role) => role.trim())) {
    const builtIn = builtInOrganizationRoles[name as keyof typeof builtInOrganizationRoles];
    const custom = customRoles.find((role) => role.role === name);
    const grants = builtIn ?? (custom ? rolePermissions(custom) : {});

    for (const [resource, actions] of Object.entries(grants))
      for (const action of actions ?? []) (result[resource] ??= new Set()).add(action);
  }

  return Object.fromEntries(Object.entries(result).map(([key, set]) => [key, [...set]]));
};

export const can = (permissions: OrganizationPermissions, resource: string, action: string) =>
  (permissions as Record<string, ReadonlyArray<string> | undefined>)[resource]?.includes(action) ??
  false;
