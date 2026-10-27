import { expect, test } from "bun:test";
import { builtInOrganizationRoles, organizationPermissionCatalog } from "@repo/api-spec";
import { organizationAccess, organizationRoles } from "./organization-access.ts";

const sorted = (record: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Object.fromEntries(
    Object.entries(record)
      .filter(([, actions]) => actions.length > 0)
      .map(([key, actions]) => [key, [...actions].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

test("the shared permission catalog matches the access controller", () => {
  const catalog = Object.fromEntries(
    Object.entries(organizationPermissionCatalog).map(([resource, { actions }]) => [
      resource,
      Object.keys(actions),
    ]),
  );

  expect(sorted(catalog)).toEqual(sorted(organizationAccess.statements));
});

test("shared built-in roles match the server's role statements", () => {
  for (const [name, role] of Object.entries(organizationRoles))
    expect(sorted(builtInOrganizationRoles[name as keyof typeof builtInOrganizationRoles])).toEqual(
      sorted(role.statements as Record<string, ReadonlyArray<string>>),
    );
});
