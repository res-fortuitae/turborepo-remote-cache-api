import { afterEach, expect, test } from "bun:test";
import { togglePermission } from "../pages/RolesPage.tsx";
import {
  can,
  effectivePermissions,
  listMembers,
  MEMBER_PAGE_SIZE,
  rolePermissions,
} from "./org-admin.ts";

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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("member pagination requests the next offset with stable ordering", async () => {
  const requests: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "https://example.test");
    requests.push(url);
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ members: [{ id: String(offset + 1) }], total: MEMBER_PAGE_SIZE + 1 });
  }) as typeof fetch;

  const first = await listMembers("org", undefined, 0);
  const next = await listMembers("org", undefined, MEMBER_PAGE_SIZE);
  expect(first.members[0]?.id).toBe("1");
  expect(next.members[0]?.id).toBe(String(MEMBER_PAGE_SIZE + 1));
  expect(requests.map((url) => url.searchParams.get("sortBy"))).toEqual(["id", "id"]);
  expect(requests[1]?.searchParams.get("limit")).toBe(String(MEMBER_PAGE_SIZE));
});
