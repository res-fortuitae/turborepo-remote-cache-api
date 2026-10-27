/**
 * Organization role statements, as plain data for clients such as the custom
 * role editor. `@repo/auth` tests pin this to its access controller.
 */
export const organizationPermissionCatalog = {
  organization: {
    label: "Organization",
    actions: {
      update: "Rename the organization",
      delete: "Delete the organization",
      transfer: "Transfer ownership",
    },
  },
  member: {
    label: "Members",
    actions: { create: "Add members", update: "Change member roles", delete: "Remove members" },
  },
  invitation: {
    label: "Invitations",
    actions: { create: "Invite people", cancel: "Cancel invitations" },
  },
  team: {
    label: "Groups",
    actions: {
      create: "Create groups",
      update: "Rename groups and change members",
      delete: "Delete groups",
    },
  },
  ac: {
    label: "Custom roles",
    actions: {
      create: "Create roles",
      read: "View roles",
      update: "Edit roles",
      delete: "Delete roles",
    },
  },
  project: {
    label: "Projects",
    actions: {
      create: "Create projects",
      read: "View all projects",
      update: "Change project settings",
      delete: "Delete projects",
      grant: "Grant project access",
    },
  },
  trustPolicy: {
    label: "Trust policies",
    actions: {
      create: "Create trust policies",
      update: "Edit trust policies",
      delete: "Delete trust policies",
    },
  },
  apiKey: {
    label: "API keys",
    actions: { create: "Create API keys", revoke: "List and revoke API keys" },
  },
  audit: {
    label: "Audit log",
    actions: { read: "Read the audit log", export: "Export the audit log" },
  },
  analytics: { label: "Analytics", actions: { read: "View analytics" } },
  billing: { label: "Billing", actions: { update: "Change billing" } },
  settings: { label: "Settings", actions: { update: "Change organization policy" } },
} as const;

export type OrganizationResource = keyof typeof organizationPermissionCatalog;
export type OrganizationPermissions = Readonly<
  Partial<Record<OrganizationResource, ReadonlyArray<string>>>
>;

const everything = Object.fromEntries(
  Object.entries(organizationPermissionCatalog).map(([resource, { actions }]) => [
    resource,
    Object.keys(actions),
  ]),
) as OrganizationPermissions;

/** Built-in roles. Custom roles are stored per organization. */
export const builtInOrganizationRoles: Readonly<
  Record<"owner" | "admin" | "member" | "auditor", OrganizationPermissions>
> = {
  owner: everything,
  admin: { ...everything, organization: ["update"] },
  member: {},
  auditor: { audit: ["read"], analytics: ["read"] },
};
