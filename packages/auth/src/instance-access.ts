import { admin } from "better-auth/plugins/admin";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const instanceAccess = createAccessControl({
  ...defaultStatements,
  audit: ["read", "export"],
  analytics: ["read"],
  settings: ["update"],
  organization: ["list", "create", "archive", "delete", "transfer", "elevate"],
});

export const instanceRoles = {
  owner: instanceAccess.newRole(instanceAccess.statements),
  admin: instanceAccess.newRole({
    user: ["list", "get", "ban", "set-role"],
    session: ["list", "revoke", "delete"],
    audit: ["read", "export"],
    analytics: ["read"],
    settings: ["update"],
    organization: ["list", "create", "archive", "delete", "transfer", "elevate"],
  }),
  auditor: instanceAccess.newRole({
    audit: ["read", "export"],
    analytics: ["read"],
    organization: ["list"],
  }),
  member: instanceAccess.newRole({}),
};

export const instanceAdmin = () =>
  admin({
    ac: instanceAccess,
    roles: instanceRoles,
    defaultRole: "member",
    adminRoles: ["owner", "admin"],
    impersonationSessionDuration: 300,
  });
