import { expect, test } from "bun:test";
import { togglePermission } from "../pages/RolesPage.tsx";
import { can, effectivePermissions, rolePermissions } from "./org-admin.ts";

const custom = [
  { id: "r1", role: "release-manager", permission: '{"project":["update"],"apiKey":["create"]}' },
  { id: "r2", role: "viewer", permission: { audit: ["read"] } },
];

test("unions built-in and custom roles like the server", () => {
  const permissions = effectivePermissions("member, release-manager,viewer", custom);

  expect(can(permissions, "project", "update")).toBe(true);
  expect(can(permissions, "apiKey", "create")).toBe(true);
  expect(can(permissions, "audit", "read")).toBe(true);
  expect(can(permissions, "member", "delete")).toBe(false);
});

test("owner and admin differ only in organization administration", () => {
  const owner = effectivePermissions("owner", []);
  const admin = effectivePermissions("admin", []);

  expect(can(owner, "organization", "delete")).toBe(true);
  expect(can(admin, "organization", "delete")).toBe(false);
  expect(can(admin, "organization", "update")).toBe(true);
  expect(can(admin, "member", "delete")).toBe(true);
});

test("unknown roles and malformed custom permissions grant nothing", () => {
  expect(effectivePermissions("ghost", custom)).toEqual({});
  expect(rolePermissions({ permission: "{bad" })).toEqual({});
});

test("toggling permissions adds, removes and drops empty resources", () => {
  const on = togglePermission({}, "audit", "read", true);

  expect(on).toEqual({ audit: ["read"] });
  expect(togglePermission(on, "audit", "read", false)).toEqual({});
});
